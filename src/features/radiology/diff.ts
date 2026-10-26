// Word-level diff of two texts (revision history of a radiology report).
export type DiffPart = { t: 'same' | 'add' | 'del'; text: string }

export function htmlToText(html: string | undefined | null): string {
  const s = html ?? ''
  if (!/<[a-z][\s\S]*>/i.test(s)) return s
  const doc = new DOMParser().parseFromString(`<body>${s.replace(/<\/(p|div|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li>/gi, '- ')}</body>`, 'text/html')
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export function wordDiff(a: string, b: string): DiffPart[] {
  const x = a.split(/(\s+)/).filter((w) => w !== '')
  const y = b.split(/(\s+)/).filter((w) => w !== '')
  const n = x.length
  const m = y.length
  // Longest common subsequence table (reports are short; capped to keep huge texts responsive).
  if (n * m > 4_000_000) return [{ t: 'del', text: a }, { t: 'add', text: b }]
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffPart[] = []
  const push = (t: DiffPart['t'], text: string) => {
    const last = out[out.length - 1]
    if (last && last.t === t) last.text += text
    else out.push({ t, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { push('same', x[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', x[i++])
    else push('add', y[j++])
  }
  while (i < n) push('del', x[i++])
  while (j < m) push('add', y[j++])
  return out
}
