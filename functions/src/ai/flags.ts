import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { z } from 'zod'
import { ANTHROPIC_API_KEY, REFUSAL_TEXT, createMessage, getClient, loadAiSettings, requireAiEnabled, textOf } from './claude'
import { db, FLAG_ROLES, REGION, requireRole, validLabId } from './common'
import { ageInDays, rangeText, type ParamDef } from './interpret'
import { meterAi } from './usage'

// Advisory flag suggestions for result entry. Reads results, reference ranges and the patient's earlier
// results, and returns suggestions only. It NEVER writes to results: a person decides what to apply.

const SYSTEM_PROMPT = `You assist a laboratory technician or pathologist who is entering or reviewing results. You receive one patient's age and gender and, for each test, its parameters with the entered value, unit, the reference range, the flag the lab's rules already gave it, and the patient's earlier values for the same parameter with how many days ago they were measured.

Suggest flags the reviewer should look at again. Rules:
- Use only the data provided. Never invent values, ranges or history.
- Suggest a flag only when it differs from the current flag, or when a large change from the earlier values deserves attention even though the value is inside the range. Skip parameters that look fine.
- suggestedFlag is one of: low, high, critical, abnormal, normal, review. Use review for a notable change from earlier values that stays within the range.
- A critical suggestion needs the value to be far outside the range; say how far.
- Give a one-sentence reason that quotes the numbers (value, range, earlier value).
- These are suggestions for a human. Do not diagnose.
Return JSON: suggestions array of {key, testId, suggestedFlag, reason}. Return an empty array when nothing needs attention.`

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Parameter key exactly as provided.' },
          testId: { type: 'string', description: 'Test id exactly as provided.' },
          suggestedFlag: { type: 'string', enum: ['low', 'high', 'critical', 'abnormal', 'normal', 'review'] },
          reason: { type: 'string' },
        },
        required: ['key', 'testId', 'suggestedFlag', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
}
const OutputZ = z.object({ suggestions: z.array(z.object({ key: z.string(), testId: z.string(), suggestedFlag: z.enum(['low', 'high', 'critical', 'abnormal', 'normal', 'review']), reason: z.string() })) })

type Vals = Record<string, { value?: string; abnormal?: string | null; critical?: boolean }>

export const suggestResultFlags = onCall({ region: REGION, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  const data = (request.data ?? {}) as { labId?: unknown; orderId?: unknown; testIds?: unknown }
  const labId = validLabId(data.labId)
  const caller = await requireRole(request, labId, FLAG_ROLES)
  const orderId = typeof data.orderId === 'string' && data.orderId && !data.orderId.includes('/') ? data.orderId : ''
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required.')
  const only = Array.isArray(data.testIds) ? new Set(data.testIds.map(String).filter((x) => x && !x.includes('/'))) : null

  const settings = await loadAiSettings(labId)
  requireAiEnabled(settings)

  const orderRef = db().doc(`labs/${labId}/orders/${orderId}`)
  const [orderSnap, resultsSnap] = await Promise.all([orderRef.get(), orderRef.collection('results').get()])
  const order = orderSnap.data()
  if (!order || order.deleted === true) throw new HttpsError('not-found', 'Bill not found.')
  const results = resultsSnap.docs.filter((d) => !only || only.has(d.id))
  if (!results.length) throw new HttpsError('failed-precondition', 'There are no results on this bill yet.')

  await meterAi(labId, caller, 'interpret')
  const client = getClient()

  const ageUnit = String(order.ageUnit ?? 'year')
  const ageValue = Number(order.ageValue ?? 0)
  const days = ageInDays(ageValue, ageUnit)

  // Earlier bills of the same patient (newest first, up to 6).
  const prior: { id: string; at: number }[] = []
  if (typeof order.patientId === 'string' && order.patientId) {
    const snap = await db().collection(`labs/${labId}/orders`).where('patientId', '==', order.patientId).select('createdAt', 'deleted').limit(60).get()
    const cur = order.createdAt?.toMillis?.() ?? Date.now()
    for (const d of snap.docs) {
      const x = d.data()
      const at = x.createdAt?.toMillis?.() ?? 0
      if (d.id !== orderId && x.deleted !== true && at && at < cur) prior.push({ id: d.id, at })
    }
    prior.sort((a, b) => b.at - a.at)
    prior.length = Math.min(prior.length, 6)
  }

  const tests: { testId: string; test: string; parameters: unknown[] }[] = []
  const known = new Map<string, { name: string; testId: string }>()
  for (const r of results) {
    const testSnap = await db().doc(`labs/${labId}/tests/${r.id}`).get()
    const test = testSnap.data()
    if (!test) continue
    const vals = (r.data().values ?? {}) as Vals
    // Earlier values of this test.
    const earlier = (await Promise.all(prior.map((p) => db().doc(`labs/${labId}/orders/${p.id}/results/${r.id}`).get()))).map((s, i) => ({ vals: (s.data()?.values ?? {}) as Vals, at: prior[i].at }))
    const parameters = ((test.parameters ?? []) as ParamDef[])
      .filter((p) => p.structure !== 'group')
      .flatMap((p) => {
        const v = vals[p.key]
        if (!v || !String(v.value ?? '').trim()) return []
        known.set(`${r.id}:${p.key}`, { name: p.name, testId: r.id })
        return [
          {
            key: p.key,
            name: p.name,
            value: String(v.value).trim(),
            unit: p.unit ?? '',
            referenceRange: rangeText(p, days),
            currentFlag: v.critical ? 'critical' : (v.abnormal ?? 'none'),
            earlier: earlier
              .flatMap((e) => (e.vals[p.key] && String(e.vals[p.key].value ?? '').trim() ? [{ value: String(e.vals[p.key].value).trim(), daysAgo: Math.round((Date.now() - e.at) / 86_400_000) }] : []))
              .slice(0, 4),
          },
        ]
      })
    if (parameters.length) tests.push({ testId: r.id, test: String(test.name ?? r.data().testName ?? r.id), parameters })
  }
  if (!tests.length) throw new HttpsError('failed-precondition', 'Enter result values before asking for suggestions.')

  const payload = { patient: { age: `${ageValue} ${ageUnit}${ageValue === 1 ? '' : 's'}`, gender: String(order.gender ?? 'unknown') }, tests }
  const response = await createMessage(client, {
    model: settings.model,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Results (JSON):\n${JSON.stringify(payload)}` }],
    maxTokens: 8000,
    effort: 'low',
    jsonSchema: OUTPUT_SCHEMA,
  })
  if (response.stop_reason === 'refusal') throw new HttpsError('failed-precondition', REFUSAL_TEXT)
  if (response.stop_reason === 'max_tokens') throw new HttpsError('internal', 'The AI response was cut off. Please try again.')
  let parsed: z.infer<typeof OutputZ>
  try {
    parsed = OutputZ.parse(JSON.parse(textOf(response)))
  } catch {
    throw new HttpsError('internal', 'The AI returned an unreadable response. Please try again.')
  }
  // Keep only suggestions that point at a real parameter we sent.
  const suggestions = parsed.suggestions.flatMap((s) => {
    const k = known.get(`${s.testId}:${s.key}`)
    return k ? [{ testId: s.testId, parameter: k.name, parameterKey: s.key, suggestedFlag: s.suggestedFlag, reason: s.reason }] : []
  })
  return { advisory: true as const, suggestions }
})
