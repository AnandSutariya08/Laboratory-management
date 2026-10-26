import { useMemo } from 'react'
import { useLabSettings } from '../../hooks/useCatalogue'
import type { RadiologyConfig } from '../../types'

// Lab-configurable radiology settings (RAD-07, RAD-15, RAD-21, RAD-11): modality codes, viewer base URL,
// accession barcode, autosave. Stored in `radiologyConfig` on the lab doc.
export const DEFAULT_MODALITIES: RadiologyConfig['modalities'] = [
  { code: 'CR', label: 'X-Ray' }, { code: 'US', label: 'USG' }, { code: 'CT', label: 'CT' }, { code: 'MR', label: 'MRI' },
  { code: 'ECG', label: 'ECG' }, { code: 'UC', label: 'Echo' }, { code: 'MG', label: 'Mammography' }, { code: 'OT', label: 'Other' },
]

export const DEFAULT_RAD_CONFIG: RadiologyConfig = {
  modalities: DEFAULT_MODALITIES,
  viewerBaseUrl: '',
  accessionBarcode: true,
  autosaveSeconds: 30,
  externalReaders: [],
}

export const mergeRadConfig = (raw: Partial<RadiologyConfig> | undefined): RadiologyConfig => ({
  ...DEFAULT_RAD_CONFIG,
  ...(raw ?? {}),
  modalities: raw?.modalities?.length ? raw.modalities : DEFAULT_MODALITIES,
})

export function useRadConfig(): RadiologyConfig {
  const s = useLabSettings()
  return useMemo(() => mergeRadConfig(s.radiologyConfig), [s.radiologyConfig])
}

// A stored modality can be a code (US) or a label (USG): the label is what the app shows.
export const modalityLabel = (m: string, list: RadiologyConfig['modalities']) =>
  list.find((x) => x.label.toLowerCase() === m.toLowerCase())?.label ?? list.find((x) => x.code.toLowerCase() === m.toLowerCase())?.label ?? m

export const isUltrasound = (modality: string, list: RadiologyConfig['modalities'] = DEFAULT_MODALITIES) => {
  const code = list.find((x) => x.label.toLowerCase() === modality.toLowerCase() || x.code.toLowerCase() === modality.toLowerCase())?.code ?? ''
  return code.toUpperCase() === 'US' || /\b(usg|ultrasound|sonograph)/i.test(modality)
}

// Study link from the lab viewer base URL and the study UID. https only; the UID is never a token.
export function buildViewerUrl(base: string, studyUid: string): string {
  const b = base.trim()
  const uid = studyUid.trim()
  if (!b || !uid || !/^[\w.\-]{1,128}$/.test(uid)) return ''
  try {
    const u = new URL(b.includes('{studyUid}') ? b.replace('{studyUid}', encodeURIComponent(uid)) : `${b.replace(/\/+$/, '')}/${encodeURIComponent(uid)}`)
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : ''
  } catch {
    return ''
  }
}
