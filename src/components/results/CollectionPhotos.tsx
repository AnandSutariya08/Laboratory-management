import { useEffect, useRef, useState } from 'react'
import { App } from 'antd'
import { CameraOutlined, PictureOutlined } from '@ant-design/icons'
import { Button } from '../../design/Button'
import { MAX_PHOTOS, photoUrl, uploadCollectionPhotos, type PhotoMeta } from '../../lib/accession'

// Photos taken when the sample was collected. New photos go to Firebase Storage (camera on a phone, or a file
// pick on a desktop); bills made before keep their inline photos, which are shown too.
export default function CollectionPhotos({
  orderId,
  files = [],
  legacy = [],
  canAdd,
  who,
}: {
  orderId: string
  files?: PhotoMeta[]
  legacy?: string[]
  canAdd: boolean
  who: { uid: string; name: string }
}) {
  const { message } = App.useApp()
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const cam = useRef<HTMLInputElement>(null)
  const pick = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    files.forEach((f) => {
      if (urls[f.path]) return
      photoUrl(f.path)
        .then((u) => !cancelled && setUrls((m) => ({ ...m, [f.path]: u })))
        .catch(() => undefined)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.map((f) => f.path).join('|')])

  const upload = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    try {
      await uploadCollectionPhotos(orderId, [...list], who, files.length + legacy.length)
      message.success('Photo saved')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save the photo')
    } finally {
      setBusy(false)
      if (cam.current) cam.current.value = ''
      if (pick.current) pick.current.value = ''
    }
  }

  const total = files.length + legacy.length
  return (
    <div>
      {total ? (
        <div className="re-photos">
          {files.map((f, i) =>
            urls[f.path] ? (
              <a key={f.path} href={urls[f.path]} target="_blank" rel="noreferrer" aria-label={`Open collection photo ${i + 1}`}>
                <img src={urls[f.path]} alt={`Collection photo ${i + 1}`} />
              </a>
            ) : (
              <div key={f.path} className="wl-muted">Loading photo</div>
            ),
          )}
          {legacy.map((src, i) => <img key={`l${i}`} src={src} alt={`Collection photo ${files.length + i + 1}`} />)}
        </div>
      ) : (
        <div className="wl-muted">No collection photos yet.</div>
      )}
      {canAdd && (
        <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-2)', flexWrap: 'wrap' }}>
          <input ref={cam} type="file" hidden accept="image/*" capture="environment" aria-label="Take collection photo" onChange={(e) => upload(e.target.files)} />
          <input ref={pick} type="file" hidden accept="image/*" multiple aria-label="Choose collection photo" onChange={(e) => upload(e.target.files)} />
          <Button icon={<CameraOutlined />} disabled={busy || total >= MAX_PHOTOS} onClick={() => cam.current?.click()}>Take photo</Button>
          <Button icon={<PictureOutlined />} disabled={busy || total >= MAX_PHOTOS} onClick={() => pick.current?.click()}>Choose file</Button>
        </div>
      )}
    </div>
  )
}
