import qrcode from 'qrcode-generator'

export function qrDataUrl(text: string): string {
  try {
    const q = qrcode(0, 'M')
    q.addData(text)
    q.make()
    return q.createDataURL(3, 0)
  } catch {
    return ''
  }
}
