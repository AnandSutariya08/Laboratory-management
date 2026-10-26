import { useEffect, useRef, useState } from 'react'
import { Button } from '../../design/Button'

// Finger / mouse signature capture. onChange gives a PNG data URL, or '' when cleared.
export default function SignaturePad({ onChange, height = 160 }: { onChange: (dataUrl: string) => void; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#111827'
  }, [])

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * ref.current!.width, y: ((e.clientY - r.top) / r.height) * ref.current!.height }
  }
  const down = (e: React.PointerEvent) => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    ref.current!.setPointerCapture(e.pointerId)
    drawing.current = true
    const p = pos(e)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
  }
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return
    const ctx = ref.current!.getContext('2d')!
    const p = pos(e)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
  }
  const up = () => {
    if (!drawing.current) return
    drawing.current = false
    setEmpty(false)
    onChange(ref.current!.toDataURL('image/png'))
  }
  const clear = () => {
    const c = ref.current!
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
    setEmpty(true)
    onChange('')
  }

  return (
    <div>
      <canvas
        ref={ref}
        width={600}
        height={height * 2}
        aria-label="Signature area"
        style={{ width: '100%', height, border: '1px dashed var(--c-outline, #94a3b8)', borderRadius: 8, background: '#fff', touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <Button variant="text" onClick={clear} disabled={empty}>Clear signature</Button>
    </div>
  )
}
