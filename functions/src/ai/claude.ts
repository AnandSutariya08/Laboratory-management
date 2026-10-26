import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, BetaMessageParam, BetaTextBlockParam, BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { defineSecret } from 'firebase-functions/params'
import { HttpsError } from 'firebase-functions/v2/https'
import * as logger from 'firebase-functions/logger'
import { db } from './common'
import { clean } from '../secrets'

export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')

export const DEFAULT_MODEL = 'claude-opus-5-5'

export interface AiSettings {
  enabled: boolean
  model: string
  publicApiBaseUrl: string
}

export async function loadAiSettings(labId: string): Promise<AiSettings> {
  const d = ((await db().doc(`labs/${labId}`).get()).data() ?? {}) as Record<string, unknown>
  const model = typeof d.aiModel === 'string' && d.aiModel.trim() ? d.aiModel.trim() : DEFAULT_MODEL
  return {
    enabled: d.aiEnabled === true,
    model,
    publicApiBaseUrl: typeof d.publicApiBaseUrl === 'string' ? d.publicApiBaseUrl.trim().replace(/\/+$/, '') : '',
  }
}

export function requireAiEnabled(settings: AiSettings): void {
  if (!settings.enabled) {
    throw new HttpsError('failed-precondition', 'AI features are turned off. An admin can enable them in Lab Profile.')
  }
}

function apiKey(): string {
  try {
    return clean(ANTHROPIC_API_KEY.value())
  } catch {
    return ''
  }
}

// Never fabricates an answer: with no key configured the call fails clearly.
export function getClient(): Anthropic {
  const key = apiKey()
  if (!key) throw new HttpsError('failed-precondition', 'AI is not configured: set the ANTHROPIC_API_KEY secret')
  return new Anthropic({ apiKey: key, timeout: 240_000, maxRetries: 2 })
}

export type Effort = 'low' | 'medium' | 'high'

export interface MessageRequest {
  model: string
  system: BetaTextBlockParam[]
  messages: BetaMessageParam[]
  tools?: BetaTool[]
  maxTokens: number
  // Top-level cache_control: also caches the growing message prefix across tool-loop turns.
  autoCache?: boolean
  // Replayed thinking blocks survive later edits of the system prompt / tools (drop_block instead of a 400).
  dropStaleThinking?: boolean
  effort: Effort
  // JSON schema for structured outputs (output_config.format).
  jsonSchema?: Record<string, unknown>
}

// One Messages API call on the beta surface:
// - thinking: omitted (adaptive is always on for claude-opus-5-5; disabling is a 400); the analyst
//   chat additionally sends adaptive + block_binding.prefix_mismatch_behavior 'drop_block'
// - output_config.effort: caller-chosen (default for the model is medium)
// - server-side fallback: betas ['server-side-fallback-2026-07-01'] + fallbacks 'default'
//   (not sent for Haiku models, which have no server-side fallback)
// - tool_choice is left unset (auto): forced tool use is a 400 on claude-opus-5-5
function buildParams(req: MessageRequest) {
  const useFallback = !/haiku/i.test(req.model)
  const bindingControls = req.dropStaleThinking === true && /opus-5-5/i.test(req.model)
  const betas = [
    ...(useFallback ? ['server-side-fallback-2026-07-01'] : []),
    ...(bindingControls ? ['thinking-binding-controls-2026-08-01'] : []),
  ]
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(betas.length ? { betas } : {}),
    ...(useFallback ? { fallbacks: 'default' as const } : {}),
    ...(bindingControls
      ? { thinking: { type: 'adaptive' as const, block_binding: { prefix_mismatch_behavior: 'drop_block' as const } } }
      : {}),
    output_config: {
      effort: req.effort,
      ...(req.jsonSchema ? { format: { type: 'json_schema' as const, schema: req.jsonSchema } } : {}),
    },
    ...(req.autoCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    system: req.system,
    ...(req.tools ? { tools: req.tools } : {}),
    messages: req.messages,
  }
}

export async function createMessage(client: Anthropic, req: MessageRequest): Promise<BetaMessage> {
  try {
    return await client.beta.messages.create(buildParams(req))
  } catch (e) {
    throw toHttpsError(e)
  }
}

export class StreamCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

// Same request as createMessage, streamed. onText receives each text delta as it arrives;
// isCancelled is polled (on every delta and every 400ms) and aborts the request when it turns true.
export async function createMessageStream(
  client: Anthropic,
  req: MessageRequest,
  hooks: { onText: (delta: string) => void; isCancelled: () => boolean },
): Promise<BetaMessage> {
  const stream = client.beta.messages.stream(buildParams(req))
  let cancelled = false
  const check = () => {
    if (!cancelled && hooks.isCancelled()) {
      cancelled = true
      stream.abort()
    }
  }
  stream.on('text', (delta: string) => {
    hooks.onText(delta)
    check()
  })
  const timer = setInterval(check, 400)
  try {
    return await stream.finalMessage()
  } catch (e) {
    if (cancelled || hooks.isCancelled()) throw new StreamCancelled()
    throw toHttpsError(e)
  } finally {
    clearInterval(timer)
  }
}

export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e
  if (e instanceof Anthropic.APIError) {
    logger.error('Anthropic API error', { status: e.status, name: e.name, message: e.message })
    if (e instanceof Anthropic.RateLimitError) {
      return new HttpsError('resource-exhausted', 'The AI service is busy right now. Please try again in a minute.')
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return new HttpsError('failed-precondition', 'AI is not configured correctly: the ANTHROPIC_API_KEY was rejected.')
    }
    if (e instanceof Anthropic.NotFoundError) {
      return new HttpsError('failed-precondition', 'The selected AI model is not available. Choose another model in Lab Profile.')
    }
    if (e instanceof Anthropic.BadRequestError) {
      return new HttpsError('internal', 'The AI request was rejected. Please try again, or start a new chat.')
    }
    if (e instanceof Anthropic.APIConnectionTimeoutError) {
      return new HttpsError('deadline-exceeded', 'The AI service took too long to respond. Please try again.')
    }
    if (e instanceof Anthropic.APIConnectionError) {
      return new HttpsError('unavailable', 'Could not reach the AI service. Please try again.')
    }
    if (e instanceof Anthropic.InternalServerError) {
      return new HttpsError('unavailable', 'The AI service is temporarily unavailable. Please try again shortly.')
    }
    return new HttpsError('internal', 'The AI service returned an error. Please try again.')
  }
  logger.error('Unexpected AI error', e)
  return new HttpsError('internal', 'Something went wrong while contacting the AI service.')
}

export function textOf(message: BetaMessage): string {
  return message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

export const REFUSAL_TEXT = 'I cannot help with that request. Try rephrasing it as a question about your lab data.'
