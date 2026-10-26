import { meterAi } from './usage'
import { Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { z } from 'zod'
import { ANTHROPIC_API_KEY, REFUSAL_TEXT, createMessage, getClient, loadAiSettings, requireAiEnabled, textOf } from './claude'
import { db, INTERPRET_ROLES, REGION, requireRole, validLabId } from './common'

const SYSTEM_PROMPT = `You assist a pathologist who is reviewing a laboratory report. You receive one test's results for one patient: the patient's age and gender, the test name, and for each parameter its value, unit, the lab's reference range, and whether the lab flagged it low, high or critical. No other patient information is provided or needed.

Write a draft interpretation for the reviewing pathologist:
- Use only the data provided. Do not invent values, history, symptoms or medications, and do not mention anything that is not in the data.
- Be clinically cautious. Describe patterns and what they may suggest; never state a diagnosis with certainty. Use wording such as "may suggest", "is consistent with" and "needs clinical correlation".
- Write in plain language that a general practitioner or an informed patient can follow.
- Say when values are within their reference range. If everything is within range, say so clearly.
- Mention flagged values (low, high, critical) and which parameters are involved. For a critical value, say that it needs prompt attention.
- Suggest sensible follow-up: clinical correlation, repeat testing, or related tests when the pattern warrants it. Do not recommend treatment or drugs.
- Keep it concise: a summary of two to four sentences, one short note per parameter that deserves comment (skip unremarkable parameters unless noting they are normal in the summary), and a short suggestions paragraph.

Return JSON with: summary (string), findings (array of {parameter, note}), suggestions (string).`

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two to four sentence overview in plain language.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          parameter: { type: 'string', description: 'Parameter name exactly as provided.' },
          note: { type: 'string', description: 'What the value means in context.' },
        },
        required: ['parameter', 'note'],
        additionalProperties: false,
      },
    },
    suggestions: { type: 'string', description: 'Follow-up or correlation suggestions; empty string if none.' },
  },
  required: ['summary', 'findings', 'suggestions'],
  additionalProperties: false,
}

const OutputSchema = z.object({
  summary: z.string(),
  findings: z.array(z.object({ parameter: z.string(), note: z.string() })),
  suggestions: z.string(),
})

export const ageInDays = (value: number, unit: string) =>
  unit === 'year' ? Math.round(value * 365.25) : unit === 'month' ? Math.round(value * 30.44) : value

export interface ParamDef {
  key: string
  name: string
  structure?: string
  unit?: string
  low?: number | null
  high?: number | null
  ranges?: { fromDays: number; toDays: number; low: number | null; high: number | null; displayText: string }[]
  displayRange?: string
}

export function rangeText(p: ParamDef, ageDays: number): string {
  const band = (p.ranges ?? []).find((r) => ageDays >= r.fromDays && ageDays <= r.toDays)
  const low = band ? band.low : (p.low ?? null)
  const high = band ? band.high : (p.high ?? null)
  return (
    band?.displayText ||
    p.displayRange ||
    (low !== null && high !== null ? `${low} - ${high}` : low !== null ? `> ${low}` : high !== null ? `< ${high}` : '')
  )
}

export const interpretResult = onCall(
  { region: REGION, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: '512MiB' },
  async (request) => {
    const data = (request.data ?? {}) as { labId?: unknown; orderId?: unknown; testId?: unknown; speed?: unknown }
    const labId = validLabId(data.labId)
    const caller = await requireRole(request, labId, INTERPRET_ROLES)
    const orderId = typeof data.orderId === 'string' && data.orderId && !data.orderId.includes('/') ? data.orderId : ''
    const testId = typeof data.testId === 'string' && data.testId && !data.testId.includes('/') ? data.testId : ''
    if (!orderId || !testId) throw new HttpsError('invalid-argument', 'orderId and testId are required.')
    // Speed picked in result entry maps to thinking effort; anything else stays at low.
    const effort = ({ fast: 'low', balanced: 'medium', thorough: 'high' } as const)[data.speed as 'fast'] ?? 'low'

    const settings = await loadAiSettings(labId)
    requireAiEnabled(settings)
    await meterAi(labId, caller, 'interpret')
    const client = getClient()

    const resultRef = db().doc(`labs/${labId}/orders/${orderId}/results/${testId}`)
    const [orderSnap, testSnap, resultSnap] = await Promise.all([
      db().doc(`labs/${labId}/orders/${orderId}`).get(),
      db().doc(`labs/${labId}/tests/${testId}`).get(),
      resultRef.get(),
    ])
    const order = orderSnap.data()
    const test = testSnap.data()
    const result = resultSnap.data()
    if (!order || !test || !result) throw new HttpsError('not-found', 'Result not found.')

    const ageUnit = String(order.ageUnit ?? 'year')
    const ageValue = Number(order.ageValue ?? 0)
    const days = ageInDays(ageValue, ageUnit)
    const values = (result.values ?? {}) as Record<string, { value?: string; abnormal?: 'low' | 'high' | null; critical?: boolean }>

    // De-identified payload: age, gender, test name and parameter values only.
    const parameters = ((test.parameters ?? []) as ParamDef[])
      .filter((p) => p.structure !== 'group')
      .flatMap((p) => {
        const v = values[p.key]
        if (!v || !String(v.value ?? '').trim()) return []
        return [
          {
            name: p.name,
            value: String(v.value).trim(),
            unit: p.unit ?? '',
            referenceRange: rangeText(p, days),
            flag: v.abnormal ?? 'none',
            critical: v.critical === true,
          },
        ]
      })
    if (parameters.length === 0) throw new HttpsError('failed-precondition', 'Enter result values before requesting an interpretation.')

    const payload = {
      patient: { age: `${ageValue} ${ageUnit}${ageValue === 1 ? '' : 's'}`, gender: String(order.gender ?? 'unknown') },
      test: String(test.name ?? result.testName ?? 'Unknown test'),
      parameters,
    }

    const response = await createMessage(client, {
      model: settings.model,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Lab result data (JSON):\n${JSON.stringify(payload)}` }],
      maxTokens: 8000,
      effort,
      jsonSchema: OUTPUT_SCHEMA,
    })

    if (response.stop_reason === 'refusal') throw new HttpsError('failed-precondition', REFUSAL_TEXT)
    if (response.stop_reason === 'max_tokens') {
      throw new HttpsError('internal', 'The AI response was cut off. Please try again.')
    }
    let parsed: z.infer<typeof OutputSchema>
    try {
      parsed = OutputSchema.parse(JSON.parse(textOf(response)))
    } catch {
      throw new HttpsError('internal', 'The AI returned an unreadable response. Please try again.')
    }

    const generatedAt = Timestamp.now()
    const doc = {
      summary: parsed.summary,
      findings: parsed.findings,
      suggestions: parsed.suggestions,
      model: response.model || settings.model,
      generatedAt,
      generatedBy: caller.uid,
      status: 'draft' as const,
    }
    await resultRef.update({ aiInterpretation: doc })
    // Timestamps do not survive callable serialisation; send an ISO string instead.
    return { ...doc, generatedAt: generatedAt.toDate().toISOString() }
  },
)
