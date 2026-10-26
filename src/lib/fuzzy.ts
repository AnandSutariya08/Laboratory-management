// Fuzzy name match (0-100) used to pair an extracted analyte with the round's parameter.
export function nameScore(a: string, b: string): number {
  const tok = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const A = tok(a)
  const B = tok(b)
  if (!A.length || !B.length) return 0
  if (A.join(' ') === B.join(' ')) return 100
  const sa = new Set(A)
  const inter = B.filter((t) => sa.has(t)).length
  const dice = (2 * inter) / (A.length + B.length)
  const sub = A.join(' ').includes(B.join(' ')) || B.join(' ').includes(A.join(' ')) ? 0.25 : 0
  return Math.min(100, Math.round((dice + sub) * 100))
}
export const EXTRACT_MIN_SCORE = 45
