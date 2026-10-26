import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { meterAi } from './usage'
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import * as logger from 'firebase-functions/logger'
import { z } from 'zod'
import { AnalyticsContext, AnalyticsQuerySchema, istDate, parseQuery, runQuery } from './analytics'
import { ANTHROPIC_API_KEY, REFUSAL_TEXT, StreamCancelled, createMessage, createMessageStream, getClient, loadAiSettings, requireAiEnabled, textOf, type MessageRequest } from './claude'
import { ACCESS_ROLES, DATASETS, DATASET_LABELS, accessFromLab, loadAccessMap, loadDatasetAccess, metricDataset, requireDataset, requireQueryAccess, type Dataset } from './datasets'
import { ADMIN_ROLES, ANALYST_ROLES, clean, db, REGION, requireRole, resolveBranch, validLabId, type Caller } from './common'
import { GROUP_BYS, METRICS, PRESETS, WIDGET_KINDS, type AnalyticsQuery, type AnalyticsResult, type DashboardWidget } from './types'
import * as dt from './dataTools'

const MAX_ITERATIONS = 8
const MAX_MESSAGE_CHARS = 4000
const MAX_TRANSCRIPT_MESSAGES = 200
const MAX_TRANSCRIPT_CHARS = 1_500_000
const MAX_RESULT_ROWS_FOR_MODEL = 100
const DISPLAY_DOC_BUDGET = 800_000

// Stable on purpose: no dates, ids or lab-specific values. Everything volatile goes
// in the user turn so the cached prefix (tools + system) is reused across chats.
const SYSTEM_PROMPT = `You are the data analyst assistant for an Indian diagnostic laboratory (a lab information system). You help lab owners and managers understand their business from the lab's own data.

How you work:
- Every number you state must come from a tool result in this conversation. Never guess, estimate, extrapolate or recall figures from memory. If you need a number, call a tool (run_analytics for most questions; list_top_n, compare_periods, get_bill_stats, qc_summary, bookings_summary, patient_demographics and lookup_tests for the specific cases they cover).
- If a tool returns no rows or a zero total, say plainly that there is no data for that period. Do not invent explanations.
- If a request is ambiguous (for example no period is given), pick a sensible default (the last 30 days), say which period you used, and continue.
- You may call several tools in one turn when the questions are independent.
- If a tool returns an error, read it, correct the query and retry once; if it still fails, tell the user what could not be answered.
- You only have read-only access, and only to the datasets listed in your context. You never see patient names, phone numbers or emails: where a patient list is available it shows initials, age and gender only. You cannot change bills, results or settings. If asked for something outside your datasets, say that your access does not include it and that a lab admin can change it under Data access.
- When the user asks for a dashboard, or for something to monitor regularly, build it with save_dashboard (3 to 8 widgets, each with a clear title and a suitable kind) and then tell them it was saved. Otherwise offer a dashboard briefly when a topic looks like something they would track repeatedly. Never save a dashboard the user did not ask for or agree to. New dashboards start private to their owner; the owner can share them with roles from the dashboard page. When the context says you are editing an existing dashboard, change it with update_dashboard (send the complete new widget list) instead of saving a new one.

Analytics reference:
- Metrics: revenue = net billed amount of non-cancelled bills created in the period (after discounts, excluding refunded tests). collections = money received in the period by payment date, including dues cleared, minus refunds. dues = outstanding balance on bills created in the period. refunds = money refunded in the period. discounts = discount given on bills created in the period. bills = number of bills. patients = distinct patients billed. tests = number of tests billed (package members counted individually). tat = average turnaround minutes from sample received to report ready, with the share of tests finished within their target time (percentWithinTat in extra). bookings = home-collection / visit bookings created in the period.
- groupBy: none, day, week (starting Monday), month, referrer, department, test, paymentMode (cash, upi, card), status (report status for bills, entry type for collections, booking status for bookings), user (staff who created the bill or posted the payment).
- Not every combination exists: collections and refunds support none, day, week, month, referrer, paymentMode, status, user; bookings support none, day, week, month, referrer, status, user; dues does not support department or test. Dues with groupBy none lists the largest outstanding bills by bill number.
- Ranges: use a preset (today, yesterday, last7, last30, thisMonth, lastMonth, last90, thisYear) or explicit from/to dates (YYYY-MM-DD, both inclusive, at most 366 days). All dates are in the lab's local time.
- Ranked groupings return the top rows by value (default 20); time groupings return every day, week or month in order.

Style:
- Be brief and direct. Lead with the answer, then at most a few supporting points. Use short bullet lists or a compact table for comparisons.
- Format money in Indian rupees with the rupee sign and Indian digit grouping, for example ₹1,24,500 or ₹12,450.50 when paise matter.
- State the period you analysed. Mention anything that limits the answer (empty data, a capped list).
- Do not claim to have drawn a chart; the app renders tool results as charts and tables beside your answer.`


// ---- Tool schemas (strict) ----------------------------------------------------

const RANGE_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      properties: { preset: { type: 'string', enum: [...PRESETS] } },
      required: ['preset'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD (lab local time).' },
        to: { type: 'string', description: 'Last day included, YYYY-MM-DD (lab local time).' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  ],
} as const

// Metric / groupBy enums are narrowed to what the caller's datasets allow.
const metricsFor = (allowed: Set<Dataset>) => METRICS.filter((m) => allowed.has(metricDataset(m)))

const querySchema = (metrics: readonly string[]) =>
  ({
    type: 'object',
    properties: {
      metric: { type: 'string', enum: [...metrics], description: 'What to measure.' },
      groupBy: { type: 'string', enum: [...GROUP_BYS], description: 'How to break the metric down; "none" for a single total.' },
      range: RANGE_SCHEMA,
      limit: { type: 'integer', description: 'Maximum rows for ranked groupings (default 20).' },
    },
    required: ['metric', 'groupBy', 'range'],
    additionalProperties: false,
  }) as const

const widgetsSchema = (metrics: readonly string[]) => ({
  type: 'array',
  description: '3 to 8 widgets.',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      kind: { type: 'string', enum: [...WIDGET_KINDS], description: 'kpi for a single number, line for time series, bar or pie for breakdowns, table for lists.' },
      query: querySchema(metrics),
    },
    required: ['title', 'kind', 'query'],
    additionalProperties: false,
  },
})

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): BetaTool => ({
  name,
  description,
  strict: true,
  input_schema: { type: 'object', properties, required, additionalProperties: false } as unknown as BetaTool.InputSchema,
})

function toolsFor(allowed: Set<Dataset>, canEditDashboard: boolean): BetaTool[] {
  const metrics = metricsFor(allowed)
  const out: BetaTool[] = []
  if (metrics.length) {
    out.push({
      name: 'run_analytics',
      description:
        'Run one read-only analytics query over the lab data and return aggregate rows and a total. Money values are in Indian rupees. Use this for most numbers you report.',
      strict: true,
      input_schema: querySchema(metrics) as unknown as BetaTool.InputSchema,
    })
    out.push(
      tool(
        'list_top_n',
        'Rank groups of one metric and return the top (or bottom) N, for example the 10 busiest referrers or the 5 slowest tests. Not for time series.',
        {
          metric: { type: 'string', enum: [...metrics] },
          groupBy: { type: 'string', enum: GROUP_BYS.filter((g) => g !== 'none' && g !== 'day' && g !== 'week' && g !== 'month') },
          range: RANGE_SCHEMA,
          n: { type: 'integer', description: 'How many rows (1 to 100, default 10).' },
          order: { type: 'string', enum: ['desc', 'asc'], description: 'desc = highest first (default), asc = lowest first.' },
        },
        ['metric', 'groupBy', 'range', 'n', 'order'],
      ),
    )
    out.push(
      tool(
        'compare_periods',
        'Compare one metric between two periods (for example this month against last month), overall and per group, with the change and percentage change.',
        {
          metric: { type: 'string', enum: [...metrics] },
          groupBy: { type: 'string', enum: GROUP_BYS.filter((g) => g !== 'day' && g !== 'week' && g !== 'month') },
          rangeA: RANGE_SCHEMA,
          rangeB: RANGE_SCHEMA,
        },
        ['metric', 'groupBy', 'rangeA', 'rangeB'],
      ),
    )
  }
  if (allowed.has('bills')) {
    out.push(
      tool(
        'get_bill_stats',
        'Bill-level statistics for a period: number of bills, net billed, average bill value, outstanding dues, bills with dues, discounts and counts by report status. No patient details.',
        { range: RANGE_SCHEMA },
        ['range'],
      ),
    )
  }
  if (allowed.has('qc')) {
    out.push(
      tool(
        'qc_summary',
        'Internal quality-control runs per machine over the last N days: runs, passed, warnings, failures and pass rate.',
        { days: { type: 'integer', description: 'Look-back window in days, 1 to 90.' } },
        ['days'],
      ),
    )
  }
  if (allowed.has('bookings')) {
    out.push(tool('bookings_summary', 'Bookings (home collection and visit requests) for a period: total, by status, top referrers and busiest days.', { range: RANGE_SCHEMA }, ['range']))
  }
  if (allowed.has('tests')) {
    out.push(
      tool(
        'lookup_tests',
        'Look up the test catalogue: code, name, department and price. Filter by text or department name.',
        { search: { type: 'string', description: 'Matches test code or name; empty for no filter.' }, department: { type: 'string', description: 'Exact department name; empty for no filter.' } },
        ['search', 'department'],
      ),
    )
  }
  if (allowed.has('patients_masked')) {
    out.push(tool('patient_demographics', 'New patients registered in a period, split by gender and age band. Aggregates only.', { range: RANGE_SCHEMA }, ['range']))
    out.push(
      tool(
        'list_patients_masked',
        'Most recently registered patients, masked: initials, age, gender and last four digits of the phone only. Never names.',
        { limit: { type: 'integer', description: 'How many, 1 to 50.' } },
        ['limit'],
      ),
    )
  }
  out.push(
    tool(
      'save_dashboard',
      'Save a dashboard of analytics widgets for the team to open later. Each widget stores its query (not data), so it stays up to date. Only use this when the user asked for a dashboard or agreed to one.',
      {
        title: { type: 'string', description: 'Dashboard title.' },
        description: { type: 'string', description: 'One sentence on what the dashboard shows.' },
        widgets: widgetsSchema(metrics),
      },
      ['title', 'description', 'widgets'],
    ),
  )
  if (canEditDashboard) {
    out.push(
      tool(
        'update_dashboard',
        'Replace the title, description and widgets of the dashboard being edited in this chat. Send the complete new widget list. Only for the dashboard named in the context.',
        {
          title: { type: 'string' },
          description: { type: 'string' },
          widgets: widgetsSchema(metrics),
        },
        ['title', 'description', 'widgets'],
      ),
    )
  }
  return out
}

const RangeZ = z.union([z.object({ preset: z.enum(PRESETS) }).strict(), z.object({ from: z.string().min(8), to: z.string().min(8) }).strict()])
const TopNZ = z.object({ metric: z.enum(METRICS), groupBy: z.enum(GROUP_BYS), range: RangeZ, n: z.number().int().min(1).max(100).default(10), order: z.enum(['desc', 'asc']).default('desc') }).strict()
const CompareZ = z.object({ metric: z.enum(METRICS), groupBy: z.enum(GROUP_BYS), rangeA: RangeZ, rangeB: RangeZ }).strict()
const RangeOnlyZ = z.object({ range: RangeZ }).strict()
const SaveDashboardSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  widgets: z
    .array(z.object({ title: z.string().trim().min(1).max(120), kind: z.enum(WIDGET_KINDS), query: AnalyticsQuerySchema }))
    .min(1)
    .max(12),
})

// ---- Transcript persistence ---------------------------------------------------
// labs/{labId}/aiChats/{chatId}/transcript/{00000..}: one doc per API message
// ({seq, role, json}), append-only; assistant content is stored exactly as returned.

const seqId = (n: number) => String(n).padStart(5, '0')

async function loadTranscript(labId: string, chatId: string): Promise<BetaMessageParam[]> {
  const snap = await db().collection(`labs/${labId}/aiChats/${chatId}/transcript`).orderBy('seq').get()
  let chars = 0
  const msgs = snap.docs.map((d) => {
    const x = d.data()
    chars += String(x.json).length
    return { role: x.role, content: JSON.parse(String(x.json)) } as BetaMessageParam
  })
  if (msgs.length > MAX_TRANSCRIPT_MESSAGES || chars > MAX_TRANSCRIPT_CHARS) {
    throw new HttpsError('failed-precondition', 'This chat has become too long. Please start a new chat.')
  }
  return msgs
}

async function appendTranscript(labId: string, chatId: string, startSeq: number, msgs: BetaMessageParam[]): Promise<void> {
  const col = db().collection(`labs/${labId}/aiChats/${chatId}/transcript`)
  const batch = db().batch()
  msgs.forEach((m, i) => {
    const json = JSON.stringify(m.content)
    if (json.length > 900_000) throw new HttpsError('resource-exhausted', 'The AI response was too large to save.')
    // create() fails if the slot exists, so two racing requests cannot both append.
    batch.create(col.doc(seqId(startSeq + i)), { seq: startSeq + i, role: m.role, json })
  })
  try {
    await batch.commit()
  } catch (e) {
    if ((e as { code?: number }).code === 6) throw new HttpsError('aborted', 'This chat is busy with another request. Please retry.')
    throw e
  }
}

// ---- Streaming sink -------------------------------------------------------------
// labs/{labId}/aiChats/{chatId}/stream/current: {userId, turnId, status, text, steps, cancel, updatedAt}.
// Only the server writes it (throttled to ~300ms); the owner may set `cancel`.

interface StepLite {
  tool: string
  summary: string
}

class StreamSink {
  private text = ''
  private steps: StepLite[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private last = 0
  private chain: Promise<unknown> = Promise.resolve()
  private unsub: (() => void) | null = null
  cancelled = false

  constructor(
    private ref: DocumentReference,
    private base: { userId: string; turnId: string },
  ) {}

  async start(): Promise<void> {
    await this.ref.set({ ...this.base, status: 'running', text: '', steps: [], cancel: false, updatedAt: Timestamp.now() })
    this.unsub = this.ref.onSnapshot(
      (s) => {
        if (s.data()?.cancel === true) this.cancelled = true
      },
      () => undefined,
    )
  }
  append(delta: string) {
    this.text += delta
    this.schedule(false)
  }
  resetText() {
    this.text = ''
    this.schedule(false)
  }
  step(s: StepLite) {
    this.steps.push(s)
    this.schedule(true)
  }
  private schedule(now: boolean) {
    const wait = Math.max(0, 300 - (Date.now() - this.last))
    if (now || wait === 0) this.write()
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.write()
      }, wait)
    }
  }
  private write() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.last = Date.now()
    const payload = { text: this.text, steps: this.steps, updatedAt: Timestamp.now() }
    this.chain = this.chain.then(() => this.ref.update(payload)).catch(() => undefined)
  }
  async finish(status: 'done' | 'error', text: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.unsub?.()
    this.unsub = null
    await this.chain
    await this.ref.update({ status, text, steps: this.steps, updatedAt: Timestamp.now() }).catch(() => undefined)
  }
}

// ---- Tools --------------------------------------------------------------------

function modelView(r: AnalyticsResult) {
  return {
    unit: r.unit,
    from: r.from,
    to: r.to,
    total: r.total,
    rowCount: r.rows.length,
    rows: r.rows.slice(0, MAX_RESULT_ROWS_FOR_MODEL),
  }
}

// One entry per tool call: what was asked and how many rows came back (the "how was this computed" panel).
export interface Step {
  tool: string
  summary: string
  dataset?: string
  spec?: unknown
  rowCount?: number
  ok: boolean
}

const rangeText = (r: unknown): string => {
  const x = r as { preset?: string; from?: string; to?: string } | undefined
  return x?.preset ? String(x.preset) : x?.from ? `${x.from} to ${x.to}` : ''
}

interface LoopState {
  labId: string
  uid: string
  name: string
  role: string
  ctx: AnalyticsContext
  allowed: Set<Dataset>
  results: AnalyticsResult[]
  steps: Step[]
  dashboardId?: string
  editDashboardId?: string
  canEditDashboard: boolean
  sink?: StreamSink
}

const widgetsFrom = (list: z.infer<typeof SaveDashboardSchema>['widgets'], allowed: Set<Dataset>): DashboardWidget[] =>
  list.map((w, i) => {
    const q = parseQuery(w.query) as AnalyticsQuery
    requireQueryAccess(allowed, q)
    return { id: `w${i + 1}`, title: w.title, kind: w.kind, query: q }
  })

async function execTool(block: BetaToolUseBlock, st: LoopState): Promise<BetaToolResultBlockParam> {
  const fail = (msg: string): BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: msg })
  const done = (payload: unknown, step: Omit<Step, 'tool' | 'ok'>): BetaToolResultBlockParam => {
    const s: Step = { tool: block.name, ok: true, ...step }
    st.steps.push(s)
    st.sink?.step({ tool: s.tool, summary: s.summary })
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(payload) }
  }
  const failStep = (summary: string) => {
    st.steps.push({ tool: block.name, ok: false, summary })
    st.sink?.step({ tool: block.name, summary })
  }
  try {
    switch (block.name) {
      case 'run_analytics': {
        const q = parseQuery(block.input)
        requireQueryAccess(st.allowed, q)
        const result = await runQuery(st.labId, q, st.ctx)
        st.results.push(result)
        return done(modelView(result), {
          summary: `${q.metric} by ${q.groupBy}, ${rangeText(q.range)}`,
          dataset: metricDataset(q.metric),
          spec: { metric: q.metric, groupBy: q.groupBy, range: q.range, ...(q.limit ? { limit: q.limit } : {}) },
          rowCount: result.rows.length,
        })
      }
      case 'list_top_n': {
        const a = TopNZ.parse(block.input)
        requireDataset(st.allowed, metricDataset(a.metric))
        const result = await dt.listTopN(st.labId, st.ctx, a)
        st.results.push(result)
        return done(modelView(result), {
          summary: `${a.order === 'asc' ? 'bottom' : 'top'} ${a.n} ${a.metric} by ${a.groupBy}, ${rangeText(a.range)}`,
          dataset: metricDataset(a.metric),
          spec: a,
          rowCount: result.rows.length,
        })
      }
      case 'compare_periods': {
        const a = CompareZ.parse(block.input)
        requireDataset(st.allowed, metricDataset(a.metric))
        const res = await dt.comparePeriods(st.labId, st.ctx, a)
        st.results.push(...res.results)
        const { results: _unused, ...view } = res
        void _unused
        return done(view, {
          summary: `compare ${a.metric} by ${a.groupBy}: ${rangeText(a.rangeA)} vs ${rangeText(a.rangeB)}`,
          dataset: metricDataset(a.metric),
          spec: a,
          rowCount: res.rows.length,
        })
      }
      case 'get_bill_stats': {
        requireDataset(st.allowed, 'bills')
        const a = RangeOnlyZ.parse(block.input)
        const res = await dt.getBillStats(st.labId, st.ctx, a.range)
        return done(res, { summary: `bill statistics, ${rangeText(a.range)}`, dataset: 'bills', spec: a, rowCount: res.bills })
      }
      case 'qc_summary': {
        requireDataset(st.allowed, 'qc')
        const days = Math.min(90, Math.max(1, Number((block.input as { days?: unknown }).days) || 30))
        const res = await dt.qcSummary(st.labId, days, st.ctx.branchId)
        return done(res, { summary: `QC runs, last ${days} days`, dataset: 'qc', spec: { days }, rowCount: res.machines.length })
      }
      case 'bookings_summary': {
        requireDataset(st.allowed, 'bookings')
        const a = RangeOnlyZ.parse(block.input)
        const res = await dt.bookingsSummary(st.labId, st.ctx, a.range)
        st.results.push(...res.results)
        const { results: _unused, ...view } = res
        void _unused
        return done(view, { summary: `bookings summary, ${rangeText(a.range)}`, dataset: 'bookings', spec: a, rowCount: res.byStatus.length })
      }
      case 'lookup_tests': {
        requireDataset(st.allowed, 'tests')
        const i = block.input as { search?: string; department?: string }
        const res = await dt.catalogueLookup(st.labId, st.ctx, { search: i.search || undefined, department: i.department || undefined, limit: 50 })
        return done(res, { summary: `test catalogue lookup${i.search ? ` "${i.search}"` : ''}${i.department ? ` in ${i.department}` : ''}`, dataset: 'tests', spec: i, rowCount: res.tests.length })
      }
      case 'patient_demographics': {
        requireDataset(st.allowed, 'patients_masked')
        const a = RangeOnlyZ.parse(block.input)
        const res = await dt.patientDemographics(st.labId, a.range)
        return done(res, { summary: `new patient demographics, ${rangeText(a.range)}`, dataset: 'patients_masked', spec: a, rowCount: res.newPatients })
      }
      case 'list_patients_masked': {
        requireDataset(st.allowed, 'patients_masked')
        const limit = Math.min(50, Math.max(1, Number((block.input as { limit?: unknown }).limit) || 20))
        const res = await dt.listPatientsMasked(st.labId, { limit })
        return done(res, { summary: `recent patients (masked), up to ${limit}`, dataset: 'patients_masked', spec: { limit }, rowCount: res.patients.length })
      }
      case 'save_dashboard': {
        const parsed = SaveDashboardSchema.safeParse(block.input)
        if (!parsed.success) return fail(`Invalid dashboard: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        const widgets = widgetsFrom(parsed.data.widgets, st.allowed)
        const ref = db().collection(`labs/${st.labId}/aiDashboards`).doc()
        const now = Timestamp.now()
        await ref.set({
          title: parsed.data.title,
          description: parsed.data.description,
          widgets: clean(widgets),
          createdBy: st.uid,
          createdByName: st.name,
          sharedWithRoles: [],
          createdAt: now,
          updatedAt: now,
        })
        st.dashboardId = ref.id
        return done({ saved: true, dashboardId: ref.id, widgets: widgets.length, sharing: 'private to the owner until shared' }, { summary: `saved dashboard "${parsed.data.title}"`, spec: { title: parsed.data.title, widgets: widgets.map((w) => w.query) }, rowCount: widgets.length })
      }
      case 'update_dashboard': {
        if (!st.canEditDashboard || !st.editDashboardId) return fail('No dashboard is being edited in this chat.')
        const parsed = SaveDashboardSchema.safeParse(block.input)
        if (!parsed.success) return fail(`Invalid dashboard: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        const widgets = widgetsFrom(parsed.data.widgets, st.allowed)
        const ref = db().doc(`labs/${st.labId}/aiDashboards/${st.editDashboardId}`)
        const cur = (await ref.get()).data()
        if (!cur) return fail('That dashboard no longer exists.')
        if (cur.createdBy !== st.uid && !ADMIN_ROLES.includes(st.role)) return fail('Only the dashboard owner or a lab admin can change it.')
        await ref.update({ title: parsed.data.title, description: parsed.data.description, widgets: clean(widgets), updatedAt: Timestamp.now() })
        st.dashboardId = st.editDashboardId
        return done({ updated: true, dashboardId: st.editDashboardId, widgets: widgets.length }, { summary: `updated dashboard "${parsed.data.title}"`, spec: { title: parsed.data.title, widgets: widgets.map((w) => w.query) }, rowCount: widgets.length })
      }
    }
    return fail(`Unknown tool "${block.name}".`)
  } catch (e) {
    let msg: string
    if (e instanceof HttpsError) msg = e.message
    else if (e instanceof z.ZodError) msg = `Invalid input: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    else {
      msg = 'The tool failed unexpectedly.'
      logger.error('analyst tool failed', e)
    }
    failStep(`${block.name} failed: ${msg}`)
    return fail(msg)
  }
}

// ---- analystChat / analystChatStream -----------------------------------------------

interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
  results?: AnalyticsResult[]
  steps?: Step[]
  dashboardId?: string
  at: Timestamp
}

const CHAT_ID_RE = /^[A-Za-z0-9_-]{8,40}$/

async function handleChat(request: CallableRequest<unknown>, streaming: boolean) {
  const data = (request.data ?? {}) as { labId?: unknown; chatId?: unknown; message?: unknown; branchId?: unknown; turnId?: unknown; editDashboardId?: unknown }
  const labId = validLabId(data.labId)
  const caller: Caller = await requireRole(request, labId, ANALYST_ROLES)
  const branchId = resolveBranch(caller, data.branchId) // null = all branches
  const message = typeof data.message === 'string' ? data.message.trim() : ''
  if (!message) throw new HttpsError('invalid-argument', 'Type a question first.')
  if (message.length > MAX_MESSAGE_CHARS) throw new HttpsError('invalid-argument', `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`)

  const settings = await loadAiSettings(labId)
  requireAiEnabled(settings)
  const labDoc = ((await db().doc(`labs/${labId}`).get()).data() ?? {}) as Record<string, unknown>
  const allowed = accessFromLab(labDoc, caller.role)
  if (allowed.size === 0) throw new HttpsError('permission-denied', 'Your role has no AI datasets enabled. A lab admin can change this under Data access.')
  await meterAi(labId, caller, 'analyst')
  const client = getClient() // throws failed-precondition when the secret is empty

  // Load or start the chat.
  let chatId: string
  let history: BetaMessageParam[] = []
  let display: DisplayMessage[] = []
  let createdAt = Timestamp.now()
  let title = ''
  let editDashboardId = typeof data.editDashboardId === 'string' && data.editDashboardId && !data.editDashboardId.includes('/') ? data.editDashboardId : ''
  const given = data.chatId !== undefined && data.chatId !== null && data.chatId !== '' ? data.chatId : null
  if (given !== null && (typeof given !== 'string' || given.includes('/'))) throw new HttpsError('invalid-argument', 'Invalid chatId.')
  const existing = given ? (await db().doc(`labs/${labId}/aiChats/${given}`).get()).data() : undefined
  if (given && existing) {
    chatId = given
    if (existing.userId !== caller.uid) throw new HttpsError('permission-denied', 'This chat belongs to another user.')
    display = (existing.messages ?? []) as DisplayMessage[]
    createdAt = existing.createdAt ?? createdAt
    title = String(existing.title ?? '')
    editDashboardId = editDashboardId || String(existing.editDashboardId ?? '')
    history = await loadTranscript(labId, chatId)
  } else if (given && streaming && CHAT_ID_RE.test(given as string)) {
    chatId = given as string // the client picked the id of a new chat so it can listen to the stream
    title = message.length > 60 ? `${message.slice(0, 57)}...` : message
  } else if (given) {
    throw new HttpsError('not-found', 'Chat not found.')
  } else {
    chatId = db().collection(`labs/${labId}/aiChats`).doc().id
    title = message.length > 60 ? `${message.slice(0, 57)}...` : message
  }
  const baseSeq = history.length

  // The dashboard being edited: only its owner or a lab admin may change it.
  let editContext = ''
  let canEditDashboard = false
  if (editDashboardId) {
    const dsnap = (await db().doc(`labs/${labId}/aiDashboards/${editDashboardId}`).get()).data()
    if (!dsnap) editDashboardId = ''
    else {
      canEditDashboard = dsnap.createdBy === caller.uid || ADMIN_ROLES.includes(caller.role)
      editContext = canEditDashboard
        ? `\n[You are editing the dashboard "${String(dsnap.title ?? '')}". Its current definition: ${JSON.stringify({ title: dsnap.title, description: dsnap.description, widgets: dsnap.widgets })}. Apply the user's requested changes with update_dashboard, sending the full widget list.]`
        : `\n[The dashboard "${String(dsnap.title ?? '')}" can be changed only by its owner or a lab admin; do not try to edit it.]`
    }
  }

  let sink: StreamSink | undefined
  if (streaming) {
    const ref = db().doc(`labs/${labId}/aiChats/${chatId}/stream/current`)
    const prev = (await ref.get()).data()
    if (prev && prev.userId !== caller.uid) throw new HttpsError('permission-denied', 'This chat belongs to another user.')
    sink = new StreamSink(ref, { userId: caller.uid, turnId: typeof data.turnId === 'string' ? data.turnId.slice(0, 40) : '' })
    await sink.start()
  }

  // Volatile context lives in the user turn, never in the cached system prompt.
  const datasetList = [...allowed].map((d) => `${d} (${DATASET_LABELS[d]})`).join('; ')
  const userText = `[Context: today is ${istDate()}, timezone Asia/Kolkata, currency INR. Data scope: ${branchId ? `branch "${branchId}" only` : 'all branches combined'}. Datasets you may use: ${datasetList}.]${editContext}\n\n${message}`
  const messages: BetaMessageParam[] = [...history, { role: 'user', content: userText }]
  const system = [{ type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } }]
  const tools = toolsFor(allowed, canEditDashboard)

  const st: LoopState = {
    labId,
    uid: caller.uid,
    name: caller.name,
    role: caller.role,
    ctx: new AnalyticsContext(labId, branchId),
    allowed,
    results: [],
    steps: [],
    editDashboardId: editDashboardId || undefined,
    canEditDashboard,
    sink,
  }
  let persist = true
  let finalText = ''
  let lastResponse: BetaMessage | null = null
  let capped = false
  let stopped = false

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (sink?.cancelled) {
        stopped = true
        break
      }
      const req: MessageRequest = { model: settings.model, system, tools, messages, maxTokens: 16000, effort: 'medium', autoCache: true }
      let response: BetaMessage
      if (sink) {
        sink.resetText()
        try {
          response = await createMessageStream(client, req, { onText: (d) => sink!.append(d), isCancelled: () => sink!.cancelled })
        } catch (e) {
          if (e instanceof StreamCancelled) {
            stopped = true
            break
          }
          throw e
        }
      } else {
        response = await createMessage(client, req)
      }
      lastResponse = response

      if (response.stop_reason === 'refusal') {
        // Roll back this turn entirely; a refused turn must not become history.
        persist = false
        finalText = REFUSAL_TEXT
        break
      }

      // Append-only: the assistant turn goes back exactly as returned (thinking blocks included).
      messages.push({ role: 'assistant', content: response.content as unknown as BetaContentBlockParam[] })

      if (response.stop_reason === 'pause_turn') continue

      const toolUses = response.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use')
      if (response.stop_reason === 'max_tokens' && toolUses.length > 0) {
        persist = false // truncated tool input: never run it, never keep it
        finalText = 'That answer needed more room than I have. Please ask a narrower question.'
        break
      }
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        finalText = textOf(response)
        if (response.stop_reason === 'max_tokens') finalText += `${finalText ? '\n\n' : ''}(The answer was cut short. Ask me to continue or narrow the question.)`
        break
      }

      // Independent tool calls run in parallel; all results go back in one user message.
      const toolResults = await Promise.all(toolUses.map((b) => execTool(b, st)))
      messages.push({ role: 'user', content: toolResults })
      if (i === MAX_ITERATIONS - 1) capped = true
    }

    if (stopped) {
      persist = false
      finalText = 'Stopped. Ask again whenever you are ready.'
    } else if (capped) {
      finalText = 'I reached the limit of steps for one question. Here is what I found so far; ask a follow-up to continue.'
    }
    if (!finalText && lastResponse) finalText = textOf(lastResponse)
    if (!finalText) finalText = 'I could not produce an answer. Please try rephrasing your question.'

    const now = Timestamp.now()
    const newDisplay: DisplayMessage[] = [
      { role: 'user', text: message, at: now },
      {
        role: 'assistant',
        text: finalText,
        ...(st.results.length ? { results: st.results } : {}),
        ...(st.steps.length ? { steps: st.steps } : {}),
        ...(st.dashboardId ? { dashboardId: st.dashboardId } : {}),
        at: now,
      },
    ]
    let allDisplay = clean([...display, ...newDisplay]).map((m, idx) => ({ ...m, at: idx < display.length ? display[idx].at : now }))
    // Keep the display doc under the 1 MiB limit by dropping the oldest inline results.
    for (let k = 0; JSON.stringify(allDisplay).length > DISPLAY_DOC_BUDGET && k < allDisplay.length; k++) {
      delete allDisplay[k].results
    }
    allDisplay = allDisplay.slice(-100)

    if (persist) await appendTranscript(labId, chatId, baseSeq, messages.slice(baseSeq))
    await db().doc(`labs/${labId}/aiChats/${chatId}`).set({
      title,
      userId: caller.uid,
      userName: caller.name,
      messages: allDisplay,
      ...(editDashboardId ? { editDashboardId } : {}),
      createdAt,
      updatedAt: now,
    })
    if (sink) await sink.finish('done', finalText)
    return { chatId, text: finalText, results: clean(st.results), steps: clean(st.steps), dashboardId: st.dashboardId, stopped }
  } catch (e) {
    if (sink) await sink.finish('error', e instanceof HttpsError ? e.message : 'Something went wrong. Please try again.')
    throw e
  }
}

const CHAT_OPTS = { region: REGION, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: '512MiB' as const }

export const analystChat = onCall(CHAT_OPTS, (request) => handleChat(request, false))

// Same as analystChat, but writes the in-progress answer to labs/{labId}/aiChats/{chatId}/stream/current
// so the browser can render it as it is produced and cancel it. Pass a client-made chatId (8-40 chars of
// A-Z a-z 0-9 _ -) for a new chat and a turnId that the client uses to ignore stale stream docs.
export const analystChatStream = onCall(CHAT_OPTS, (request) => handleChat(request, true))

// ---- Dataset access (admin) ------------------------------------------------------------

export const getAiDatasetAccess = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown }
  const labId = validLabId(data.labId)
  const caller = await requireRole(request, labId, ANALYST_ROLES)
  const access = await loadAccessMap(labId)
  return {
    datasets: DATASETS.map((value) => ({ value, label: DATASET_LABELS[value] })),
    roles: ACCESS_ROLES,
    access,
    mine: access[caller.role] ?? [],
    canEdit: ADMIN_ROLES.includes(caller.role),
  }
})

export const setAiDatasetAccess = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; access?: unknown }
  const labId = validLabId(data.labId)
  await requireRole(request, labId, ADMIN_ROLES)
  const raw = (data.access ?? {}) as Record<string, unknown>
  const out: Record<string, string[]> = {}
  for (const role of ACCESS_ROLES) {
    const list = raw[role]
    if (!Array.isArray(list) || list.some((x) => !(DATASETS as readonly string[]).includes(String(x)))) {
      throw new HttpsError('invalid-argument', `access.${role} must be a list of datasets: ${DATASETS.join(', ')}.`)
    }
    out[role] = [...new Set(list.map(String))]
  }
  // Admins always keep every dataset so a lab can never lock itself out.
  out.labAdmin = [...DATASETS]
  out.admin = [...DATASETS]
  await db().doc(`labs/${labId}`).update({ aiDatasetAccess: out })
  return { ok: true as const, access: out }
})

// ---- Direct analytics for the UI ---------------------------------------------------

export const runAnalytics = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; query?: unknown; branchId?: unknown }
  const labId = validLabId(data.labId)
  const caller = await requireRole(request, labId, ANALYST_ROLES)
  const branchId = resolveBranch(caller, data.branchId)
  const query = parseQuery(data.query)
  const allowed = await loadDatasetAccess(labId, caller.role)
  requireQueryAccess(allowed, query)
  return runQuery(labId, query, new AnalyticsContext(labId, branchId))
})

// ---- Dashboards: sharing -----------------------------------------------------------------

type DashDoc = { createdBy?: string; sharedWithRoles?: unknown }
// Owner and lab admins always see a dashboard. Dashboards made before sharing existed (no
// sharedWithRoles field) stay visible to every AI user; new ones are private until shared.
export function canSeeDashboard(d: DashDoc, caller: Caller): boolean {
  if (ADMIN_ROLES.includes(caller.role) || d.createdBy === caller.uid) return true
  if (!Array.isArray(d.sharedWithRoles)) return true
  return d.sharedWithRoles.map(String).includes(caller.role)
}

export const listAiDashboards = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown }
  const labId = validLabId(data.labId)
  const caller = await requireRole(request, labId, ANALYST_ROLES)
  const snap = await db().collection(`labs/${labId}/aiDashboards`).orderBy('updatedAt', 'desc').limit(200).get()
  return {
    dashboards: snap.docs
      .filter((d) => canSeeDashboard(d.data(), caller))
      .map((d) => {
        const x = d.data()
        return {
          id: d.id,
          title: String(x.title ?? ''),
          description: String(x.description ?? ''),
          widgets: (x.widgets ?? []) as DashboardWidget[],
          createdBy: String(x.createdBy ?? ''),
          createdByName: String(x.createdByName ?? ''),
          sharedWithRoles: Array.isArray(x.sharedWithRoles) ? x.sharedWithRoles.map(String) : null,
          updatedAtMs: x.updatedAt instanceof Timestamp ? x.updatedAt.toMillis() : 0,
          canEdit: x.createdBy === caller.uid || ADMIN_ROLES.includes(caller.role),
        }
      }),
  }
})

// Owner or lab admin sets which roles may open a dashboard.
export const shareAiDashboard = onCall({ region: REGION }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; dashboardId?: unknown; roles?: unknown }
  const labId = validLabId(data.labId)
  const caller = await requireRole(request, labId, ANALYST_ROLES)
  if (typeof data.dashboardId !== 'string' || !data.dashboardId || data.dashboardId.includes('/')) throw new HttpsError('invalid-argument', 'dashboardId is required.')
  const roles = Array.isArray(data.roles) ? data.roles.map(String) : null
  if (!roles || roles.some((r) => !(ANALYST_ROLES as string[]).includes(r))) throw new HttpsError('invalid-argument', `roles must be from: ${ANALYST_ROLES.join(', ')}.`)
  const ref = db().doc(`labs/${labId}/aiDashboards/${data.dashboardId}`)
  const cur = (await ref.get()).data()
  if (!cur) throw new HttpsError('not-found', 'Dashboard not found.')
  if (cur.createdBy !== caller.uid && !ADMIN_ROLES.includes(caller.role)) throw new HttpsError('permission-denied', 'Only the dashboard owner or a lab admin can change sharing.')
  await ref.update({ sharedWithRoles: [...new Set(roles)] })
  return { ok: true as const }
})

export const runDashboard = onCall({ region: REGION, timeoutSeconds: 180 }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; dashboardId?: unknown; branchId?: unknown }
  const labId = validLabId(data.labId)
  const caller = await requireRole(request, labId, ANALYST_ROLES)
  const branchId = resolveBranch(caller, data.branchId)
  if (typeof data.dashboardId !== 'string' || !data.dashboardId || data.dashboardId.includes('/')) {
    throw new HttpsError('invalid-argument', 'dashboardId is required.')
  }
  const snap = await db().doc(`labs/${labId}/aiDashboards/${data.dashboardId}`).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Dashboard not found.')
  if (!canSeeDashboard(snap.data() as DashDoc, caller)) throw new HttpsError('permission-denied', 'This dashboard is not shared with your role.')
  const allowed = await loadDatasetAccess(labId, caller.role)
  const widgets = ((snap.data()?.widgets ?? []) as DashboardWidget[]).slice(0, 24)
  const ctx = new AnalyticsContext(labId, branchId) // shared so widgets over the same range read once
  const settled = await Promise.allSettled(
    widgets.map((w) => {
      requireQueryAccess(allowed, w.query)
      return runQuery(labId, w.query, ctx)
    }),
  )
  return {
    widgets: widgets.map((w, i) => {
      const s = settled[i]
      return s.status === 'fulfilled'
        ? { ...w, result: s.value }
        : { ...w, result: null, error: s.reason instanceof HttpsError ? s.reason.message : 'This widget could not be loaded.' }
    }),
  }
})
