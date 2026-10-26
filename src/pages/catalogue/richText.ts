import { sanitizeRich } from '../../lib/results'
import type { TestExt } from './ext'

// Interpretation is stored twice: `interpretationHtml` (rich, sanitised) and `interpretation` (plain text with
// line breaks) which every older reader (server snapshot, public report, AI) keeps using.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function plainToHtml(text: string): string {
  const t = text.trim()
  if (!t) return ''
  return t.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
}

export function htmlToPlain(html: string): string {
  return sanitizeRich(html)
    .replace(/<br>/g, '\n')
    .replace(/<\/(p|div)>/g, '\n\n')
    .replace(/<\/li>/g, '\n')
    .replace(/<li>/g, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Rich interpretation of a test for the report to print: sanitised HTML, built from the plain text when no rich copy exists. */
export const interpretationHtml = (t: Partial<TestExt> | undefined): string => (t?.interpretationHtml ? sanitizeRich(t.interpretationHtml) : plainToHtml(t?.interpretation ?? ''))
