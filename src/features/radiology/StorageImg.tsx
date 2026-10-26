import { useEffect, useState } from 'react'
import { getDownloadURL, ref as storageRef } from 'firebase/storage'
import { storage } from '../../firebase'
import type { RadImage } from './types'

// Resolves a Storage path to a download URL (staff only; the storage rules decide who may read).
export function useStorageUrl(path?: string): string {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let dead = false
    setUrl('')
    if (path) getDownloadURL(storageRef(storage, path)).then((u) => !dead && setUrl(u)).catch(() => undefined)
    return () => {
      dead = true
    }
  }, [path])
  return url
}

// Key image from Storage or from an older inline data URL.
export function RadImg({ im, alt, ...rest }: { im: Pick<RadImage, 'path' | 'dataUrl' | 'name' | 'caption'>; alt?: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const url = useStorageUrl(im.dataUrl ? undefined : im.path)
  const src = im.dataUrl || url
  return src ? <img {...rest} src={src} alt={alt ?? (im.caption || im.name)} /> : <span aria-hidden="true" style={{ display: 'inline-block', width: 40, height: 40, background: '#eee' }} />
}
