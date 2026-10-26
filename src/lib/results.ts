import type { AgeRange, AgeUnit, Gender, Parameter, ParamValue } from '../types'

export function ageInDays(value: number, unit: AgeUnit): number {
  if (unit === 'year') return Math.round(value * 365.25)
  if (unit === 'month') return Math.round(value * 30.4375)
  return value
}

export interface ResolvedRange {
  low: number | null
  high: number | null
  text: string
}

type RangeOverride = NonNullable<ParamValue['rangeOverride']>

// All the patient conditions that some range of these parameters is written for (pregnancy etc.).
export function conditionsOf(params: Parameter[]): string[] {
  return [...new Set(params.flatMap((p) => p.ranges.map((r) => (r.condition ?? '').trim()).filter(Boolean)))]
}

// An age band that contains the patient's age wins over the parameter default.
// Band runs from its lower age (inclusive) to its upper age (exclusive). A band written for the patient's
// condition beats one for everybody; then a band for the patient's sex beats one marked for any sex.
// An edited range on the single result (`override`) beats everything.
export function resolveRange(p: Parameter, ageDays: number, gender?: string, condition?: string, override?: RangeOverride): ResolvedRange {
  const cond = (condition ?? '').trim()
  const sexOf = (r: AgeRange) => r.gender ?? 'any'
  const fits = p.ranges.filter(
    (r) => ageDays >= r.fromDays && ageDays < r.toDays && (!r.condition || (!!cond && r.condition === cond)) && (sexOf(r) === 'any' || sexOf(r) === gender),
  )
  const score = (r: AgeRange) => (r.condition ? 2 : 0) + (sexOf(r) !== 'any' ? 1 : 0)
  // Same specificity: the narrowest age window wins (an edge age that sits in two windows takes the tighter one).
  const band = [...fits].sort((a, b) => score(b) - score(a) || (a.toDays - a.fromDays) - (b.toDays - b.fromDays))[0]
  const low = override ? override.low : band ? band.low : p.low
  const high = override ? override.high : band ? band.high : p.high
  const computed =
    (band?.displayText || p.displayRange) ||
    (low !== null && high !== null ? `${low} - ${high}` : low !== null ? `> ${low}` : high !== null ? `< ${high}` : '')
  const auto = low !== null && high !== null ? `${low} - ${high}` : low !== null ? `> ${low}` : high !== null ? `< ${high}` : ''
  const text = override ? override.text || auto : computed
  return { low, high, text }
}

// The range text a result shows or prints: the edited one when set, else the table lookup.
export const rangeTextFor = (p: Parameter, v: ParamValue | undefined, ageDays: number, gender?: string, condition?: string) =>
  resolveRange(p, ageDays, gender, condition, v?.rangeOverride).text

export function flagValue(
  p: Parameter,
  raw: string,
  ageDays: number,
  gender?: string,
  condition?: string,
  override?: RangeOverride,
): Pick<ParamValue, 'abnormal' | 'critical' | 'criticalDir'> {
  if (p.dataType === 'options' || p.dataType === 'text') {
    const f = p.optionFlags?.[raw.trim()]
    return f === 'critical' ? { abnormal: 'abnormal', critical: true } : f === 'abnormal' ? { abnormal: 'abnormal', critical: false } : { abnormal: null, critical: false }
  }
  if (p.dataType !== 'numeric' && p.dataType !== 'numericUnbound') return { abnormal: null, critical: false }
  const v = parseNumeric(raw)
  if (v === null) return { abnormal: null, critical: false }
  const { low, high } = resolveRange(p, ageDays, gender, condition, override)
  const abnormal = low !== null && v < low ? 'low' : high !== null && v > high ? 'high' : null
  const critLow = p.criticalLow !== null && v < p.criticalLow
  const critHigh = p.criticalHigh !== null && v > p.criticalHigh
  const out: Pick<ParamValue, 'abnormal' | 'critical' | 'criticalDir'> = { abnormal, critical: critLow || critHigh }
  if (critLow) out.criticalDir = 'low'
  else if (critHigh) out.criticalDir = 'high'
  return out
}

// Flag letter shown / printed for a result: L, H, LL, HH or Abnormal (qualitative).
export function flagLetter(v: Pick<ParamValue, 'abnormal' | 'critical' | 'criticalDir'> | undefined): string {
  if (!v) return ''
  if (v.critical && v.criticalDir) return v.criticalDir === 'low' ? 'LL' : 'HH'
  return v.abnormal === 'high' ? 'H' : v.abnormal === 'low' ? 'L' : v.abnormal === 'abnormal' ? 'Abnormal' : ''
}

// Accepts "<0.5" or ">200" style results by using the bound value.
export function parseNumeric(raw: string): number | null {
  const s = raw.trim().replace(/^[<>]=?/, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// ---- Age at collection ----------------------------------------------------
type Stamp = { toMillis?: () => number; toDate?: () => Date } | Date | null | undefined
const ms = (t: Stamp): number | null => {
  if (!t) return null
  if (t instanceof Date) return t.getTime()
  if (typeof t.toMillis === 'function') return t.toMillis()
  return typeof t.toDate === 'function' ? t.toDate().getTime() : null
}

// Age in days on the day the sample was collected (falls back to the bill date, then now). With a date of birth
// the age is exact; without one the registered age is moved forward by the days between billing and collection.
export function ageDaysAtCollection(
  o: { ageValue: number; ageUnit: AgeUnit; createdAt?: Stamp; billDate?: Stamp; collectedAt?: Stamp },
  dob?: string,
): number {
  const billMs = ms(o.billDate) ?? ms(o.createdAt) ?? Date.now()
  const at = ms(o.collectedAt) ?? billMs
  if (dob) {
    const b = new Date(dob).getTime()
    if (Number.isFinite(b) && b <= at) return Math.floor((at - b) / 86_400_000)
  }
  const base = ageInDays(o.ageValue, o.ageUnit)
  return base + Math.max(0, Math.floor((at - billMs) / 86_400_000))
}

// ---- DLC total -------------------------------------------------------------
// A differential count lists several percentage parameters that add up to 100. A parameter flagged
// "omit from DLC total" in the catalogue is left out of the sum.
export const DLC_TOLERANCE = 1
export function dlcTotal(params: Parameter[], values: Record<string, ParamValue>): { total: number; complete: boolean; count: number } | null {
  const pct = params.filter((p) => p.structure !== 'group' && p.unit.trim() === '%' && ['numeric', 'numericUnbound'].includes(p.dataType))
  if (pct.length < 3) return null
  const counted = pct.filter((p) => !(p as { omitFromTotal?: boolean }).omitFromTotal)
  if (counted.length < 2) return null
  const nums = counted.map((p) => parseNumeric(values[p.key]?.value ?? ''))
  const entered = nums.filter((n): n is number => n !== null)
  if (!entered.length) return null
  return { total: Math.round(entered.reduce((a, b) => a + b, 0) * 100) / 100, complete: entered.length === counted.length, count: counted.length }
}
export const dlcOff = (t: { complete: boolean; total: number }) => t.complete && Math.abs(t.total - 100) > DLC_TOLERANCE

// ---- Delta check ----------------------------------------------------------
export interface DeltaCfg {
  pct: number // percent change that raises a flag (0 = off)
  abs: number // absolute change that raises a flag (0 = off)
  lookbackDays: number // only compare with results this recent (0 = any age)
}
export interface DeltaOut {
  pct: number | null
  abs: number
  flagged: boolean
}
// Change of the current value against a previous one. A per-parameter limit beats the lab limit; a previous
// result older than the look-back window is ignored. Null when there is nothing to compare.
export function deltaCheck(cur: string, prev: string, prevAt: Date | null, p: Parameter, cfg: DeltaCfg, now = Date.now()): DeltaOut | null {
  const a = parseNumeric(cur)
  const b = parseNumeric(prev)
  if (a === null || b === null) return null
  if (cfg.lookbackDays > 0 && prevAt && now - prevAt.getTime() > cfg.lookbackDays * 86_400_000) return null
  const pctLimit = p.deltaLimitPct ?? cfg.pct
  const absLimit = p.deltaLimitAbs ?? cfg.abs
  const pct = b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 1000) / 10
  const abs = Math.round((a - b) * 1000) / 1000
  const flagged = (pctLimit > 0 && pct !== null && Math.abs(pct) >= pctLimit) || (absLimit > 0 && Math.abs(abs) >= absLimit)
  return { pct, abs, flagged }
}

// ---- Formula evaluation --------------------------------------------------
// A small expression engine: + - * / ^, comparisons, parentheses and the functions ROUND, IF, ABS, MIN, MAX,
// SQRT, LOG, AND, OR. A name is a parameter key of the same test ("HB") or, for another test on the same bill,
// "TESTCODE.KEY" (curly braces are allowed: {HB}, {CBC.HB}). Never eval(): formulas come from catalogue data.

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string }
type FNode =
  | { k: 'num'; v: number }
  | { k: 'ref'; name: string }
  | { k: 'neg'; a: FNode }
  | { k: 'bin'; op: string; a: FNode; b: FNode }
  | { k: 'fn'; name: string; args: FNode[] }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      out.push({ t: 'num', v: Number(src.slice(i, j)) })
      i = j
    } else if (c === '{') {
      const j = src.indexOf('}', i)
      if (j < 0) throw new Error('Missing "}" in formula')
      out.push({ t: 'id', v: src.slice(i + 1, j).trim() })
      i = j + 1
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++
      out.push({ t: 'id', v: src.slice(i, j) })
      i = j
    } else if (c === '<' || c === '>' || c === '=' || c === '!') {
      const two = src.slice(i, i + 2)
      if (['<=', '>=', '==', '!=', '<>'].includes(two)) { out.push({ t: 'op', v: two === '<>' ? '!=' : two }); i += 2 }
      else if (c === '!') throw new Error('Unexpected "!" in formula')
      else { out.push({ t: 'op', v: c === '=' ? '==' : c }); i++ }
    } else if ('+-*/^(),'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
    } else {
      throw new Error(`Unexpected "${c}" in formula`)
    }
  }
  return out
}

const FN_ARITY: Record<string, [number, number]> = {
  ROUND: [1, 2], IF: [3, 3], ABS: [1, 1], MIN: [1, 99], MAX: [1, 99], SQRT: [1, 1], LOG: [1, 1], AND: [1, 99], OR: [1, 99],
}

function parse(src: string): FNode {
  const toks = tokenize(src)
  let pos = 0
  const isOp = (v: string) => toks[pos]?.t === 'op' && (toks[pos] as { v: string }).v === v
  const expr = (): FNode => {
    const left = add()
    const t = toks[pos]
    if (t?.t === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(t.v)) {
      pos++
      return { k: 'bin', op: t.v, a: left, b: add() }
    }
    return left
  }
  const add = (): FNode => {
    let left = mul()
    while (isOp('+') || isOp('-')) {
      const op = (toks[pos++] as { v: string }).v
      left = { k: 'bin', op, a: left, b: mul() }
    }
    return left
  }
  const mul = (): FNode => {
    let left = pow()
    while (isOp('*') || isOp('/')) {
      const op = (toks[pos++] as { v: string }).v
      left = { k: 'bin', op, a: left, b: pow() }
    }
    return left
  }
  const pow = (): FNode => {
    const base = unary()
    if (isOp('^')) {
      pos++
      return { k: 'bin', op: '^', a: base, b: pow() }
    }
    return base
  }
  const unary = (): FNode => {
    if (isOp('-')) {
      pos++
      return { k: 'neg', a: unary() }
    }
    if (isOp('+')) {
      pos++
      return unary()
    }
    return primary()
  }
  const primary = (): FNode => {
    const tok = toks[pos++]
    if (!tok) throw new Error('Formula ends unexpectedly')
    if (tok.t === 'num') return { k: 'num', v: tok.v }
    if (tok.t === 'id') {
      if (isOp('(')) {
        const name = tok.v.toUpperCase()
        const ar = FN_ARITY[name]
        if (!ar) throw new Error(`Unknown function ${tok.v}`)
        pos++
        const args: FNode[] = []
        if (!isOp(')')) {
          args.push(expr())
          while (isOp(',')) {
            pos++
            args.push(expr())
          }
        }
        if (!isOp(')')) throw new Error('Missing ")" in formula')
        pos++
        if (args.length < ar[0] || args.length > ar[1]) throw new Error(`${name} takes ${ar[0] === ar[1] ? ar[0] : `${ar[0]} to ${ar[1]}`} argument(s)`)
        return { k: 'fn', name, args }
      }
      return { k: 'ref', name: tok.v }
    }
    if (tok.v === '(') {
      const v = expr()
      if (!isOp(')')) throw new Error('Missing ")" in formula')
      pos++
      return v
    }
    throw new Error(`Unexpected "${tok.v}" in formula`)
  }
  const root = expr()
  if (pos < toks.length) throw new Error(`Unexpected "${(toks[pos] as { v: string | number }).v}" in formula`)
  return root
}

const roundTo = (v: number, d: number) => {
  const f = 10 ** Math.max(0, Math.min(10, Math.round(d)))
  return Math.round((v + Number.EPSILON * Math.sign(v)) * f) / f
}

function run(n: FNode, look: (name: string) => number | null): number | null {
  switch (n.k) {
    case 'num': return n.v
    case 'ref': return look(n.name)
    case 'neg': { const v = run(n.a, look); return v === null ? null : -v }
    case 'bin': {
      const a = run(n.a, look)
      const b = run(n.b, look)
      if (a === null || b === null) return null
      switch (n.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/': return b === 0 ? null : a / b
        case '^': return a ** b
        case '<': return a < b ? 1 : 0
        case '>': return a > b ? 1 : 0
        case '<=': return a <= b ? 1 : 0
        case '>=': return a >= b ? 1 : 0
        case '==': return a === b ? 1 : 0
        default: return a !== b ? 1 : 0
      }
    }
    default: {
      if (n.name === 'IF') {
        const c = run(n.args[0], look)
        if (c === null) return null
        return run(n.args[c !== 0 ? 1 : 2], look)
      }
      const vals = n.args.map((a) => run(a, look))
      if (vals.some((v) => v === null)) return null
      const x = vals as number[]
      switch (n.name) {
        case 'ROUND': return roundTo(x[0], x[1] ?? 0)
        case 'ABS': return Math.abs(x[0])
        case 'MIN': return Math.min(...x)
        case 'MAX': return Math.max(...x)
        case 'SQRT': return x[0] < 0 ? null : Math.sqrt(x[0])
        case 'LOG': return x[0] <= 0 ? null : Math.log10(x[0])
        case 'AND': return x.every((v) => v !== 0) ? 1 : 0
        default: return x.some((v) => v !== 0) ? 1 : 0
      }
    }
  }
}

function refsOf(n: FNode, out: string[] = []): string[] {
  if (n.k === 'ref') out.push(n.name)
  else if (n.k === 'neg') refsOf(n.a, out)
  else if (n.k === 'bin') { refsOf(n.a, out); refsOf(n.b, out) }
  else if (n.k === 'fn') n.args.forEach((a) => refsOf(a, out))
  return out
}

export interface FormulaOpts {
  decimals?: number // decimals kept on the result (default 2)
  external?: Record<string, number | null> // values of other tests on the bill, keyed "TESTCODE.KEY" (upper case)
}

export function evaluateFormula(formula: string, vars: Record<string, number | null>, opts: FormulaOpts = {}): number | null {
  const ast = parse(formula)
  const look = (name: string): number | null => {
    if (name in vars) return vars[name]
    const up = name.toUpperCase()
    if (opts.external && up in opts.external) return opts.external[up]
    const hit = Object.keys(vars).find((k) => k.toUpperCase() === up)
    return hit ? vars[hit] : null
  }
  const result = run(ast, look)
  return result === null || !Number.isFinite(result) ? null : roundTo(result, opts.decimals ?? 2)
}

// Names a formula uses (throws when the formula does not parse).
export const formulaRefs = (formula: string): string[] => [...new Set(refsOf(parse(formula)))]

// Loop check across a bill's tests: the chain of "TESTCODE.KEY" names that refer back to themselves, or null.
export function formulaCycle(tests: { code: string; parameters: Parameter[] }[]): string[] | null {
  const edges = new Map<string, string[]>()
  for (const t of tests) {
    const tc = t.code.toUpperCase()
    for (const p of t.parameters) {
      if (!p.formula) continue
      let refs: string[] = []
      try {
        refs = formulaRefs(p.formula)
      } catch {
        refs = []
      }
      edges.set(`${tc}.${p.key.toUpperCase()}`, refs.map((r) => (r.includes('.') ? r.toUpperCase() : `${tc}.${r.toUpperCase()}`)))
    }
  }
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  let found: string[] | null = null
  const visit = (n: string) => {
    if (found) return
    if (state.get(n) === 2) return
    if (state.get(n) === 1) {
      found = [...stack.slice(stack.indexOf(n)), n]
      return
    }
    state.set(n, 1)
    stack.push(n)
    for (const m of edges.get(n) ?? []) visit(m)
    stack.pop()
    state.set(n, 2)
  }
  for (const n of edges.keys()) visit(n)
  return found
}

// Values of every numeric parameter of the bill's tests, keyed "TESTCODE.KEY", for cross-test formulas.
export function externalValues(tests: { code: string; parameters: Parameter[] }[], valuesOf: (t: { code: string; parameters: Parameter[] }) => Record<string, ParamValue>): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const t of tests) {
    const v = valuesOf(t)
    for (const p of t.parameters) out[`${t.code.toUpperCase()}.${p.key.toUpperCase()}`] = parseNumeric(v[p.key]?.value ?? '')
  }
  return out
}

export interface ApplyOpts extends FormulaOpts {
  condition?: string
  cyclic?: string[] // parameter keys of this test that sit in a formula loop: left blank
}

// Recompute every calculated parameter that the user has not overridden.
// Runs repeatedly so formulas may depend on other calculated values.
export function applyFormulas(
  params: Parameter[],
  values: Record<string, ParamValue>,
  ageDays: number,
  gender?: string,
  opts: ApplyOpts = {},
): Record<string, ParamValue> {
  const next = { ...values }
  const loop = new Set((opts.cyclic ?? []).map((k) => k.toUpperCase()))
  for (let pass = 0; pass < 4; pass++) {
    const vars: Record<string, number | null> = {}
    for (const p of params) vars[p.key] = parseNumeric(next[p.key]?.value ?? '')
    for (const p of params) {
      if (!p.formula) continue
      let computed: number | null = null
      if (!loop.has(p.key.toUpperCase())) {
        try {
          computed = evaluateFormula(p.formula, vars, { decimals: p.decimals ?? opts.decimals, external: opts.external })
        } catch {
          computed = null
        }
      }
      const value = computed === null ? '' : String(computed)
      if (next[p.key]?.overridden) {
        // Typed over: keep the user's value, remember what the system calculated.
        if (next[p.key].overrideOfCalculated !== value) next[p.key] = { ...next[p.key], overrideOfCalculated: value }
        continue
      }
      next[p.key] = { value, overridden: false, ...(next[p.key]?.rangeOverride ? { rangeOverride: next[p.key].rangeOverride } : {}), ...flagValue(p, value, ageDays, gender, opts.condition, next[p.key]?.rangeOverride) }
    }
  }
  return next
}

export function emptyValue(): ParamValue {
  return { value: '', abnormal: null, critical: false, overridden: false }
}

export function hasAnyValue(values: Record<string, ParamValue>): boolean {
  return Object.values(values).some((v) => v.value.trim() !== '')
}

export function salutationFor(gender: Gender, ageDays: number): string {
  if (ageDays < 365 * 12) return gender === 'female' ? 'Baby' : 'Master'
  if (gender === 'female') return 'Ms.'
  if (gender === 'male') return 'Mr.'
  return ''
}

// ---- Rich text -----------------------------------------------------------
// Result text is stored as HTML, so it is reduced to a small safe tag set.
const RICH_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'SPAN'])
export function sanitizeRich(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walk = (node: Node): string => {
    let out = ''
    node.childNodes.forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE) out += (c.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const el = c as Element
        const inner = walk(el)
        out += RICH_TAGS.has(el.tagName) ? (el.tagName === 'BR' ? '<br>' : `<${el.tagName.toLowerCase()}>${inner}</${el.tagName.toLowerCase()}>`) : inner
      }
    })
    return out
  }
  return walk(doc.body)
}
export const richToText = (html: string) => sanitizeRich(html).replace(/<br>|<\/(p|div|li)>/g, ' ').replace(/<[^>]+>/g, '').trim()
