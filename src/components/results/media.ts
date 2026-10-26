// Image and PDF result parameters are stored inline on the result doc as small data URLs
// (the same approach radiology uses), so they must stay small: a result doc holds many values.
export const MAX_PARAM_IMAGE_BYTES = 150 * 1024
export const MAX_PARAM_PDF_BYTES = 300 * 1024
export const dataUrlBytes = (u: string) => Math.round((u.length - (u.indexOf(',') + 1)) * 0.75)

export function compressParamImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error(`${file.name} is not an image`))
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      for (const maxSide of [1000, 760, 560]) {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.width * scale))
        c.height = Math.max(1, Math.round(img.height * scale))
        const ctx = c.getContext('2d')
        if (!ctx) return reject(new Error('Image processing is not available'))
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.drawImage(img, 0, 0, c.width, c.height)
        for (const q of [0.7, 0.5, 0.35]) {
          const out = c.toDataURL('image/jpeg', q)
          if (dataUrlBytes(out) <= MAX_PARAM_IMAGE_BYTES) return resolve(out)
        }
      }
      reject(new Error(`${file.name} is still larger than 150 KB after compression`))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`Could not read ${file.name}`))
    }
    img.src = url
  })
}

export function readParamPdf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.type !== 'application/pdf') return reject(new Error(`${file.name} is not a PDF`))
    if (file.size > MAX_PARAM_PDF_BYTES) return reject(new Error('PDF must be 300 KB or smaller'))
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error(`Could not read ${file.name}`))
    r.readAsDataURL(file)
  })
}
