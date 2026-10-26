import type { Paise } from '../types'

export const toPaise = (rupees: number): Paise => Math.round(rupees * 100)
export const toRupees = (paise: Paise): number => paise / 100

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
})

export const formatINR = (paise: Paise): string => inr.format(paise / 100)

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]
  return `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}`.trim()
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  return [h ? `${ONES[h]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ')
}

// Indian numbering (lakh, crore) for "amount in words" on receipts.
export function rupeesInWords(paise: Paise): string {
  let n = Math.floor(Math.abs(paise) / 100)
  if (n === 0) return 'Zero Only'
  const parts: string[] = []
  const crore = Math.floor(n / 10000000)
  n %= 10000000
  const lakh = Math.floor(n / 100000)
  n %= 100000
  const thousand = Math.floor(n / 1000)
  n %= 1000
  if (crore) parts.push(`${belowThousand(crore)} Crore`)
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`)
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`)
  if (n) parts.push(belowThousand(n))
  return `${parts.join(' ')} Only`
}
