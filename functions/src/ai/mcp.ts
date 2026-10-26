import { createHash, randomBytes, randomInt } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall, onRequest, type Request } from 'firebase-functions/v2/https'
import * as logger from 'firebase-functions/logger'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { z } from 'zod'
import { AnalyticsContext, parseQuery, runQuery } from './analytics'
import * as dt from './dataTools'
import { meterAi } from './usage'
import { loadAiSettings, requireAiEnabled } from './claude'
import { ADMIN_ROLES, db, REGION, requireRole, validLabId } from './common'
import { GROUP_BYS, METRICS, PRESETS, type AnalyticsQuery } from './types'
import { FIRESTORE_DB } from '../secrets'

// Remote MCP server (Streamable HTTP, stateless, JSON responses). Read-only and
// aggregate-only: it exposes the same analytics the analyst uses plus the test
// catalogue, and never any patient-identifying data or write tools.

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

// Per-connection grants (set when the connection is created, editable by an admin).
//   scopes  ANALYTICS_READ (counts, tat, bookings) | FINANCE_READ (revenue, collections, dues, refunds,
//           discounts; also the bill-level tools) | QC_READ (aggregated QC runs) | CATALOGUE_READ (departments,
//           tests, prices) | PATIENT_READ_MASKED (patients as initials, age, gender and a masked phone; never
//           full names, phones or emails). PATIENT_READ_MASKED is opt-in: it is not part of the defaults.
//   tools   subset of the tools below; a tool is available only when named here AND its scope is granted
//   rowLimit  cap on rows any tool returns in one call
//   ipAllowlist  optional list of caller IPs; empty = any
export const MCP_SCOPES = ['ANALYTICS_READ', 'FINANCE_READ', 'QC_READ', 'CATALOGUE_READ', 'PATIENT_READ_MASKED'] as const
export type McpScope = (typeof MCP_SCOPES)[number]
const DEFAULT_SCOPES: McpScope[] = ['ANALYTICS_READ', 'FINANCE_READ', 'QC_READ', 'CATALOGUE_READ']
export const MCP_TOOLS = ['lab_info', 'get_kpis', 'run_analytics', 'list_departments', 'list_tests', 'get_qc_summary', 'get_bill', 'list_bills', 'list_dues', 'top_tests', 'bill_payments', 'list_patients_masked'] as const
const TOOL_SCOPE: Record<string, McpScope | null> = {
  lab_info: null,
  get_kpis: 'ANALYTICS_READ',
  run_analytics: 'ANALYTICS_READ',
  list_departments: 'CATALOGUE_READ',
  list_tests: 'CATALOGUE_READ',
  get_qc_summary: 'QC_READ',
  get_bill: 'FINANCE_READ',
  list_bills: 'FINANCE_READ',
  list_dues: 'FINANCE_READ',
  top_tests: 'ANALYTICS_READ',
  bill_payments: 'FINANCE_READ',
  list_patients_masked: 'PATIENT_READ_MASKED',
}
const FINANCE_METRICS = ['revenue', 'collections', 'dues', 'refunds', 'discounts']
const DEFAULT_ROW_LIMIT = 500

interface Connection {
  labId: string
  connectionId: string
  label: string
  scopes: McpScope[]
  tools: string[]
  rowLimit: number
}

const asScopes = (v: unknown): McpScope[] => (Array.isArray(v) ? v.filter((x): x is McpScope => (MCP_SCOPES as readonly string[]).includes(String(x))) : [...DEFAULT_SCOPES])
const asTools = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter((x) => (MCP_TOOLS as readonly string[]).includes(x)) : [...MCP_TOOLS])

class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function tokenFrom(req: Request): string {
  const segments = req.path.split('/').filter(Boolean)
  if (segments[0] === 'mcp') segments.shift() // reached through a Hosting rewrite at /mcp/**
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
  return segments[0] || bearer || ''
}

async function authenticate(token: string, ip: string): Promise<Connection> {
  if (!TOKEN_RE.test(token)) throw new AuthError(401, 'Invalid or missing connector token.')
  const hash = hashToken(token)
  const lookup = (await db().doc(`mcpTokens/${hash}`).get()).data()
  if (!lookup) throw new AuthError(401, 'Invalid or missing connector token.')
  const labId = String(lookup.labId)
  const connectionId = String(lookup.connectionId)
  const ref = db().doc(`labs/${labId}/mcpConnections/${connectionId}`)
  const c = (await ref.get()).data()
  if (!c || c.tokenHash !== hash) throw new AuthError(401, 'Invalid or missing connector token.')
  if (c.revoked === true) throw new AuthError(401, 'This connector has been revoked.')
  const exp = c.expiresAt instanceof Timestamp ? c.expiresAt.toMillis() : 0
  if (exp <= Date.now()) throw new AuthError(401, 'This connector has expired.')
  // A connection dies with the admin who made it: if that user is no longer active, revoke it now.
  const creator = typeof c.createdBy === 'string' && c.createdBy ? ((await db().doc(`labs/${labId}/users/${c.createdBy}`).get()).data() as { active?: boolean; deleted?: boolean } | undefined) : undefined
  if (typeof c.createdBy === 'string' && c.createdBy && (!creator || creator.active !== true || creator.deleted === true)) {
    await revokeConnection(labId, connectionId, 'owner left')
    throw new AuthError(401, 'This connector has been revoked.')
  }
  const allow = Array.isArray(c.ipAllowlist) ? c.ipAllowlist.map(String).filter(Boolean) : []
  if (allow.length && !allow.includes(ip)) throw new AuthError(403, 'This connector is not allowed from this network address.')
  const settings = await loadAiSettings(labId)
  if (!settings.enabled) throw new AuthError(403, 'AI features are turned off for this lab.')
  return {
    labId,
    connectionId,
    label: String(c.label ?? ''),
    scopes: asScopes(c.scopes),
    tools: asTools(c.tools),
    rowLimit: Math.min(5000, Math.max(1, Number(c.rowLimit) || DEFAULT_ROW_LIMIT)),
  }
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const failure = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true })

const rupees = (paise: number) => Math.round(paise) / 100

function buildServer(conn: Connection): McpServer {
  const server = new McpServer({ name: 'health-care-labs', version: '1.0.0' })
  // One context per branch scope so repeated tool calls reuse their reads. MCP
  // connections are created by admins, so any branch may be requested; default = all.
  const ctxs = new Map<string, AnalyticsContext>()
  const ctxFor = (branchId?: string): AnalyticsContext => {
    const b = branchId && branchId !== 'all' ? branchId : null
    const key = b ?? '*'
    let c = ctxs.get(key)
    if (!c) {
      c = new AnalyticsContext(conn.labId, b)
      ctxs.set(key, c)
    }
    return c
  }

  const ctx = ctxFor() // catalogue lookups (shared across branches)

  // Every tool call is audited (arguments only, never results) before it runs.
  // Tools without an input schema receive the request `extra` (headers etc.) as their first
  // argument, so pass hasArgs=false for them: it is neither audited nor forwarded.
  const audited = <A>(tool: string, fn: (args: A) => Promise<unknown>, hasArgs = true) => async (rawArgs: A): Promise<ToolResult> => {
    const args = hasArgs ? rawArgs : ({} as A)
    try {
      await db()
        .collection(`labs/${conn.labId}/mcpAudit`)
        .add({ connectionId: conn.connectionId, connectionLabel: conn.label, tool, args: JSON.parse(JSON.stringify(args ?? {})), at: Timestamp.now() })
      await db().doc(`labs/${conn.labId}/mcpConnections/${conn.connectionId}`).update({ lastUsedAt: Timestamp.now() })
      return ok(await fn(args))
    } catch (e) {
      if (e instanceof HttpsError) return failure(e.message)
      logger.error('mcp tool failed', { tool, error: e })
      return failure('The tool failed unexpectedly.')
    }
  }
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  // A tool exists for this connection only when it is listed in `tools` and its scope is granted.
  const allowed = (tool: string) => conn.tools.includes(tool) && (TOOL_SCOPE[tool] === null || conn.scopes.includes(TOOL_SCOPE[tool]!))
  const hasFinance = conn.scopes.includes('FINANCE_READ')

  if (allowed('lab_info')) server.registerTool(
    'lab_info',
    {
      title: 'Lab info',
      description: 'Basic information about the lab: name, contact details, timezone and currency.',
      annotations: readOnly,
    },
    audited('lab_info', async () => {
      const d = ((await db().doc(`labs/${conn.labId}`).get()).data() ?? {}) as Record<string, unknown>
      return {
        name: d.name ?? '',
        address: d.address ?? '',
        phone: d.phone ?? '',
        email: d.email ?? '',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
      }
    }, false),
  )

  if (allowed('get_kpis')) server.registerTool(
    'get_kpis',
    {
      title: 'Key figures',
      description:
        'Headline numbers for a period: revenue, collections, dues, refunds, discounts, bills, patients, tests and average turnaround time. Money is in Indian rupees.',
      inputSchema: {
        range: z.enum(PRESETS).default('last30').describe('Period preset; defaults to last30.'),
        branchId: z.string().max(64).optional().describe("Branch id, or 'all' (default) for every branch."),
      },
      annotations: readOnly,
    },
    audited('get_kpis', async (args: { range?: (typeof PRESETS)[number]; branchId?: string }) => {
      const ctx = ctxFor(args.branchId)
      const range = { preset: args.range ?? 'last30' } as const
      const all = ['revenue', 'collections', 'dues', 'refunds', 'discounts', 'bills', 'patients', 'tests', 'tat'] as const
      const metrics = all.filter((m) => hasFinance || !FINANCE_METRICS.includes(m))
      const results = await Promise.all(metrics.map((metric) => runQuery(conn.labId, { metric, groupBy: 'none', range }, ctx)))
      const out: Record<string, unknown> = { from: results[0].from, to: results[0].to, currency: 'INR' }
      results.forEach((r, i) => {
        out[metrics[i]] = r.total
        if (metrics[i] === 'tat') out.percentWithinTat = r.rows[0]?.extra?.percentWithinTat ?? null
      })
      out.tatUnit = 'minutes'
      return out
    }),
  )

  const rangeSchema = z.union([
    z.object({ preset: z.enum(PRESETS) }),
    z.object({ from: z.string().describe('YYYY-MM-DD'), to: z.string().describe('YYYY-MM-DD, inclusive') }),
  ])
  if (allowed('run_analytics')) server.registerTool(
    'run_analytics',
    {
      title: 'Run analytics query',
      description:
        'Aggregate analytics over lab data. Metrics: revenue, collections, dues, refunds, discounts, bills, patients, tests, tat, bookings. groupBy: none, day, week, month, referrer, department, test, paymentMode, status, user. Range is a preset or from/to dates (max 366 days, Asia/Kolkata). Returns rows and a total; money in INR.',
      inputSchema: {
        metric: z.enum(METRICS),
        groupBy: z.enum(GROUP_BYS).default('none'),
        range: rangeSchema,
        limit: z.number().int().min(1).max(500).optional(),
        branchId: z.string().max(64).optional().describe("Branch id, or 'all' (default) for every branch."),
      },
      annotations: readOnly,
    },
    audited('run_analytics', async (args: AnalyticsQuery & { branchId?: string }) => {
      const { branchId, ...query } = args
      if (!hasFinance && FINANCE_METRICS.includes(String(query.metric))) throw new HttpsError('permission-denied', 'This connection has no finance scope (FINANCE_READ).')
      const result = await runQuery(conn.labId, parseQuery({ ...query, limit: Math.min(query.limit ?? conn.rowLimit, conn.rowLimit) }), ctxFor(branchId))
      return result
    }),
  )

  if (allowed('list_departments')) server.registerTool(
    'list_departments',
    { title: 'List departments', description: 'Departments of the lab with their number of active tests.', annotations: readOnly },
    audited('list_departments', async () => {
      const [depts, tests] = await Promise.all([ctx.departments(), ctx.tests()])
      const counts = new Map<string, number>()
      for (const t of tests.values()) counts.set(t.departmentId, (counts.get(t.departmentId) ?? 0) + 1)
      return [...depts].map(([id, name]) => ({ name, tests: counts.get(id) ?? 0 }))
    }, false),
  )

  if (allowed('list_tests')) server.registerTool(
    'list_tests',
    {
      title: 'List tests',
      description: 'The lab test catalogue: code, name, department and price in rupees. Optionally filter by text or department name.',
      inputSchema: {
        search: z.string().optional().describe('Matches test code or name.'),
        department: z.string().optional().describe('Department name.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: readOnly,
    },
    audited('list_tests', async (args: { search?: string; department?: string; limit?: number }) => {
      const snap = await db().collection(`labs/${conn.labId}/tests`).get()
      const depts = await ctx.departments()
      const s = args.search?.trim().toLowerCase()
      const dep = args.department?.trim().toLowerCase()
      const rows = snap.docs
        .map((d) => d.data())
        .filter((t) => t.disabled !== true)
        .map((t) => ({
          code: String(t.code ?? ''),
          name: String(t.name ?? ''),
          department: depts.get(String(t.departmentId)) ?? '',
          priceInr: rupees(Number(t.price ?? 0)),
        }))
        .filter((t) => (!s || t.code.toLowerCase().includes(s) || t.name.toLowerCase().includes(s)) && (!dep || t.department.toLowerCase() === dep))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { count: rows.length, tests: rows.slice(0, Math.min(args.limit ?? 200, conn.rowLimit)) }
    }),
  )

  if (allowed('get_qc_summary')) server.registerTool(
    'get_qc_summary',
    {
      title: 'QC summary',
      description: 'Aggregated internal QC runs per machine for a period: runs, passed, warnings, failures and the pass rate. No patient data.',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(30).describe('Look-back window in days (default 30).'),
        branchId: z.string().max(64).optional().describe("Branch id, or 'all' (default)."),
      },
      annotations: readOnly,
    },
    audited('get_qc_summary', async (args: { days?: number; branchId?: string }) => {
      const days = args.days ?? 30
      const from = Timestamp.fromMillis(Date.now() - days * 86_400_000)
      const snap = await db().collection(`labs/${conn.labId}/qcRuns`).where('runAt', '>=', from).get()
      const branch = args.branchId && args.branchId !== 'all' ? args.branchId : null
      const byMachine = new Map<string, { machine: string; runs: number; pass: number; warning: number; fail: number }>()
      for (const d of snap.docs) {
        const r = d.data()
        if (r.deleted === true) continue
        if (branch && String(r.branchId ?? 'main') !== branch) continue
        const key = String(r.machineName ?? r.machineId ?? 'Unknown')
        const m = byMachine.get(key) ?? { machine: key, runs: 0, pass: 0, warning: 0, fail: 0 }
        m.runs++
        if (r.status === 'pass') m.pass++
        else if (r.status === 'warning') m.warning++
        else if (r.status === 'fail') m.fail++
        byMachine.set(key, m)
      }
      const rows = [...byMachine.values()].map((m) => ({ ...m, passRatePct: m.runs ? Math.round((m.pass / m.runs) * 1000) / 10 : null })).sort((a, b) => b.runs - a.runs)
      return { days, machines: rows.slice(0, conn.rowLimit) }
    }),
  )

  const hasPatientMasked = conn.scopes.includes('PATIENT_READ_MASKED')
  const limitOf = (n?: number, dflt = 50) => Math.min(Math.max(1, n ?? dflt), conn.rowLimit)
  const billNoSchema = z.string().trim().min(1).max(40).describe('Bill number as printed on the bill.')
  const branchSchema = z.string().max(64).optional().describe("Branch id, or 'all' (default).")

  if (allowed('get_bill')) server.registerTool(
    'get_bill',
    {
      title: 'Get a bill',
      description: 'One bill by its bill number: date, tests, amounts, paid, due and report status. The patient appears only as initials, age and gender, and only when the connection has the masked-patient scope.',
      inputSchema: { billNo: billNoSchema, branchId: branchSchema },
      annotations: readOnly,
    },
    audited('get_bill', async (args: { billNo: string; branchId?: string }) => dt.getBill(conn.labId, ctxFor(args.branchId), args.billNo, hasPatientMasked)),
  )

  if (allowed('list_bills')) server.registerTool(
    'list_bills',
    {
      title: 'List bills',
      description: 'Bills in a date range (max 366 days), newest first, optionally only those with an outstanding due or a given report status. Patients appear only as initials when the connection has the masked-patient scope.',
      inputSchema: {
        range: rangeSchema.describe('Preset or from/to dates.'),
        reportStatus: z.enum(['pending', 'partial', 'provisional', 'final']).optional(),
        dueOnly: z.boolean().optional().describe('Only bills with due greater than zero.'),
        limit: z.number().int().min(1).max(500).optional(),
        branchId: branchSchema,
      },
      annotations: readOnly,
    },
    audited('list_bills', async (args: { range: dt.Range; reportStatus?: string; dueOnly?: boolean; limit?: number; branchId?: string }) =>
      dt.listBills(conn.labId, ctxFor(args.branchId), { range: args.range, reportStatus: args.reportStatus, dueOnly: args.dueOnly, limit: limitOf(args.limit), withPatient: hasPatientMasked }),
    ),
  )

  if (allowed('list_dues')) server.registerTool(
    'list_dues',
    {
      title: 'List outstanding dues',
      description: 'Bills with an outstanding balance in a date range, largest due first.',
      inputSchema: {
        range: rangeSchema.default({ preset: 'last90' }).describe('Preset or from/to dates; defaults to the last 90 days.'),
        limit: z.number().int().min(1).max(500).optional(),
        branchId: branchSchema,
      },
      annotations: readOnly,
    },
    audited('list_dues', async (args: { range?: dt.Range; limit?: number; branchId?: string }) =>
      dt.listBills(conn.labId, ctxFor(args.branchId), { range: args.range ?? { preset: 'last90' }, dueOnly: true, sortByDue: true, limit: limitOf(args.limit), withPatient: hasPatientMasked }),
    ),
  )

  if (allowed('top_tests')) server.registerTool(
    'top_tests',
    {
      title: 'Top tests',
      description: 'The most (or least) billed tests in a period, by number of tests billed.',
      inputSchema: {
        range: rangeSchema.default({ preset: 'last30' }),
        limit: z.number().int().min(1).max(100).optional(),
        order: z.enum(['desc', 'asc']).optional(),
        branchId: branchSchema,
      },
      annotations: readOnly,
    },
    audited('top_tests', async (args: { range?: dt.Range; limit?: number; order?: 'desc' | 'asc'; branchId?: string }) => {
      const r = await dt.listTopN(conn.labId, ctxFor(args.branchId), { metric: 'tests', groupBy: 'test', range: args.range ?? { preset: 'last30' }, n: limitOf(args.limit, 10), order: args.order })
      return { from: r.from, to: r.to, tests: r.rows.map((x) => ({ test: x.label, count: x.value })) }
    }),
  )

  if (allowed('bill_payments')) server.registerTool(
    'bill_payments',
    {
      title: 'Payments on a bill',
      description: 'Every payment, due-clearance and refund recorded against one bill (mode, amount in rupees, date, receipt number). No patient details.',
      inputSchema: { billNo: billNoSchema, branchId: branchSchema },
      annotations: readOnly,
    },
    audited('bill_payments', async (args: { billNo: string; branchId?: string }) => dt.billPayments(conn.labId, ctxFor(args.branchId), args.billNo)),
  )

  if (allowed('list_patients_masked')) server.registerTool(
    'list_patients_masked',
    {
      title: 'Recent patients (masked)',
      description: 'Most recently registered patients as initials, age, gender and a masked phone number (last four digits). Never full names, phone numbers or emails.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: readOnly,
    },
    audited('list_patients_masked', async (args: { limit?: number }) => dt.listPatientsMasked(conn.labId, { limit: limitOf(args.limit, 50) })),
  )

  return server
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Accept',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
}

export const mcp = onRequest({ region: REGION, timeoutSeconds: 120, memory: '512MiB', cors: false }, async (req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  const rpcError = (status: number, message: string) =>
    res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })

  let conn: Connection
  try {
    conn = await authenticate(tokenFrom(req), String(req.ip ?? ''))
  } catch (e) {
    if (e instanceof AuthError) {
      rpcError(e.status, e.message)
      return
    }
    logger.error('mcp auth failed', e)
    rpcError(500, 'Internal error.')
    return
  }
  // Governance: count the call against the lab's monthly allowance and rate limit.
  try {
    await meterAi(conn.labId, { uid: `mcp:${conn.connectionId}`, name: conn.label }, 'mcp')
  } catch (e) {
    if (e instanceof HttpsError) {
      rpcError(429, e.message)
      return
    }
    logger.error('mcp metering failed', e)
  }
  // Stateless server: no sessions, so no standalone SSE stream and nothing to delete.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS')
    rpcError(405, 'Method not allowed.')
    return
  }

  const server = buildServer(conn)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    logger.error('mcp request failed', e)
    if (!res.headersSent) rpcError(500, 'Internal server error.')
  }
})

// ---- Connection management -----------------------------------------------------------

async function revokeConnection(labId: string, connectionId: string, why: string): Promise<void> {
  const ref = db().doc(`labs/${labId}/mcpConnections/${connectionId}`)
  const c = (await ref.get()).data()
  if (!c) return
  const batch = db().batch()
  batch.update(ref, { revoked: true, revokedAt: Timestamp.now(), revokedReason: why })
  if (typeof c.tokenHash === 'string' && c.tokenHash) batch.delete(db().doc(`mcpTokens/${c.tokenHash}`))
  await batch.commit()
}

// Grants from a create / update request, validated. Unknown scopes or tools are rejected.
function grantsFrom(data: { scopes?: unknown; tools?: unknown; rowLimit?: unknown; ipAllowlist?: unknown }) {
  const scopes = data.scopes === undefined ? [...DEFAULT_SCOPES] : Array.isArray(data.scopes) ? data.scopes.map(String) : null
  if (!scopes || scopes.some((x) => !(MCP_SCOPES as readonly string[]).includes(x))) throw new HttpsError('invalid-argument', `scopes must be from: ${MCP_SCOPES.join(', ')}.`)
  const tools = data.tools === undefined ? [...MCP_TOOLS] : Array.isArray(data.tools) ? data.tools.map(String) : null
  if (!tools || tools.some((x) => !(MCP_TOOLS as readonly string[]).includes(x))) throw new HttpsError('invalid-argument', `tools must be from: ${MCP_TOOLS.join(', ')}.`)
  const rowLimit = data.rowLimit === undefined ? DEFAULT_ROW_LIMIT : Number(data.rowLimit)
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 5000) throw new HttpsError('invalid-argument', 'rowLimit must be between 1 and 5000.')
  const ips = data.ipAllowlist === undefined ? [] : Array.isArray(data.ipAllowlist) ? data.ipAllowlist.map((x) => String(x).trim()).filter(Boolean) : null
  if (!ips || ips.length > 20 || ips.some((x) => x.length > 64)) throw new HttpsError('invalid-argument', 'ipAllowlist must be up to 20 addresses.')
  return { scopes, tools, rowLimit, ipAllowlist: ips }
}

// Admin edits what a connection may do (scopes, tools, row cap, IP allowlist). Takes effect on the next call.
export const updateMcpConnection = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; id?: unknown; scopes?: unknown; tools?: unknown; rowLimit?: unknown; ipAllowlist?: unknown }
  const labId = validLabId(data.labId)
  await requireRole(request, labId, ADMIN_ROLES)
  if (typeof data.id !== 'string' || !data.id || data.id.includes('/')) throw new HttpsError('invalid-argument', 'id is required.')
  const ref = db().doc(`labs/${labId}/mcpConnections/${data.id}`)
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Connection not found.')
  await ref.update(grantsFrom(data))
  return { ok: true as const }
})

// Auto-revoke: when a staff member is deactivated or deleted, every connection they created stops working.
export const revokeMcpOnUserLeave = onDocumentUpdated({ document: 'labs/{labId}/users/{uid}', database: FIRESTORE_DB, region: REGION }, async (event) => {
  const a = event.data?.after.data() as { active?: boolean; deleted?: boolean } | undefined
  const b = event.data?.before.data() as { active?: boolean; deleted?: boolean } | undefined
  if (!a || (a.active === true && a.deleted !== true)) return
  if (b && b.active !== true && b.deleted === a.deleted) return // already inactive before: nothing new
  const { labId, uid } = event.params
  const snap = await db().collection(`labs/${labId}/mcpConnections`).where('createdBy', '==', uid).get()
  for (const d of snap.docs) if (d.data().revoked !== true) await revokeConnection(labId, d.id, 'owner left')
})

function functionsBaseUrl(): string {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || ''
  if (process.env.FUNCTIONS_EMULATOR === 'true') return `http://127.0.0.1:5001/${project}/${REGION}/mcp`
  return `https://${REGION}-${project}.cloudfunctions.net/mcp`
}

const OTP_TTL_MS = 10 * 60_000
const otpHash = (id: string, otp: string) => createHash('sha256').update(`${id}:${otp}`).digest('hex')

// Step 1: the admin asks for a connection and consents. Nothing is usable yet: a one-time code is
// issued and must be confirmed (confirmMcpConnection) before a token exists. The code goes to the
// admin's own phone/email through the outbox (a provider worker delivers it; no message is sent
// from here). On the emulator the code is also returned so the flow can be tried locally.
export const createMcpConnection = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; label?: unknown; days?: unknown; consent?: unknown; scopes?: unknown; tools?: unknown; rowLimit?: unknown; ipAllowlist?: unknown }
  const labId = validLabId(data.labId)
  const caller = await requireRole(request, labId, ADMIN_ROLES)
  const settings = await loadAiSettings(labId)
  requireAiEnabled(settings)
  if (data.consent !== true) throw new HttpsError('failed-precondition', 'Confirm that you allow an external AI app to read this lab\'s aggregated numbers.')

  const label = typeof data.label === 'string' ? data.label.trim() : ''
  if (!label || label.length > 80) throw new HttpsError('invalid-argument', 'Give the connection a label (up to 80 characters).')
  const days = data.days === undefined ? 90 : Number(data.days)
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpsError('invalid-argument', 'days must be between 1 and 365.')

  const grants = grantsFrom(data)
  const ref = db().collection(`labs/${labId}/mcpConnections`).doc()
  const otp = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const now = Timestamp.now()
  await ref.create({
    label,
    status: 'pending',
    otpHash: otpHash(ref.id, otp),
    otpExpiresAt: Timestamp.fromMillis(now.toMillis() + OTP_TTL_MS),
    otpAttempts: 0,
    days,
    tokenHint: '',
    createdBy: caller.uid,
    createdByName: caller.name,
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + days * 86_400_000),
    revoked: false,
    ...grants,
    lastUsedAt: null,
    consent: { by: caller.uid, byName: caller.name, at: now, text: 'Allow an external AI app read-only access to aggregated lab figures.' },
  })
  const u = ((await db().doc(`labs/${labId}/users/${caller.uid}`).get()).data() ?? {}) as { phone?: string; email?: string }
  const to = String(u.phone || request.auth?.token.email || '')
  await db().collection(`labs/${labId}/outbox`).add({
    channel: u.phone ? 'sms' : 'email',
    to,
    kind: 'otp',
    subject: 'Your connection code',
    text: `Your code to connect "${label}" is ${otp}. It expires in 10 minutes. If you did not ask for it, ignore this message.`,
    link: '',
    waTemplate: '',
    vars: {},
    status: 'queued',
    createdAt: FieldValue.serverTimestamp(),
  })
  const emulator = process.env.FUNCTIONS_EMULATOR === 'true'
  return { id: ref.id, otpRequired: true as const, sentTo: to ? to.replace(/.(?=.{3})/g, '*') : '', expiresInMinutes: OTP_TTL_MS / 60_000, ...(emulator ? { devOtp: otp } : {}) }
})

// Step 2: the admin enters the code; the connection becomes active and the URL is shown once.
export const confirmMcpConnection = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; id?: unknown; otp?: unknown }
  const labId = validLabId(data.labId)
  const caller = await requireRole(request, labId, ADMIN_ROLES)
  const settings = await loadAiSettings(labId)
  requireAiEnabled(settings)
  if (typeof data.id !== 'string' || !data.id || data.id.includes('/')) throw new HttpsError('invalid-argument', 'id is required.')
  const otp = typeof data.otp === 'string' ? data.otp.trim() : ''
  const ref = db().doc(`labs/${labId}/mcpConnections/${data.id}`)
  const c = (await ref.get()).data()
  if (!c || c.status !== 'pending') throw new HttpsError('failed-precondition', 'This connection is not waiting for a code.')
  if (c.createdBy !== caller.uid) throw new HttpsError('permission-denied', 'Only the admin who started the connection can confirm it.')
  const exp = c.otpExpiresAt instanceof Timestamp ? c.otpExpiresAt.toMillis() : 0
  if (exp <= Date.now()) throw new HttpsError('deadline-exceeded', 'The code has expired. Start the connection again.')
  if (Number(c.otpAttempts ?? 0) >= 5) throw new HttpsError('resource-exhausted', 'Too many wrong codes. Start the connection again.')
  if (otpHash(ref.id, otp) !== c.otpHash) {
    await ref.update({ otpAttempts: FieldValue.increment(1) })
    throw new HttpsError('invalid-argument', 'That code is not right.')
  }
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const now = Timestamp.now()
  const expiresAt = Timestamp.fromMillis(now.toMillis() + Number(c.days ?? 90) * 86_400_000)
  const batch = db().batch()
  batch.update(ref, { status: 'active', tokenHash, tokenHint: token.slice(-4), expiresAt, activatedAt: now, otpHash: FieldValue.delete(), otpExpiresAt: FieldValue.delete() })
  batch.create(db().doc(`mcpTokens/${tokenHash}`), { labId, connectionId: ref.id, createdAt: FieldValue.serverTimestamp() })
  await batch.commit()
  const url = settings.publicApiBaseUrl ? `${settings.publicApiBaseUrl}/mcp/${token}` : `${functionsBaseUrl()}/${token}`
  return { id: ref.id, url, token, expiresAt: expiresAt.toDate().toISOString() }
})

export const revokeMcpConnection = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; id?: unknown }
  const labId = validLabId(data.labId)
  await requireRole(request, labId, ADMIN_ROLES)
  if (typeof data.id !== 'string' || !data.id || data.id.includes('/')) throw new HttpsError('invalid-argument', 'id is required.')
  if (!(await db().doc(`labs/${labId}/mcpConnections/${data.id}`).get()).exists) throw new HttpsError('not-found', 'Connection not found.')
  await revokeConnection(labId, data.id, 'revoked by admin')
  return { ok: true as const }
})
