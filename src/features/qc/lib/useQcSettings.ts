import { useMemo } from 'react'
import { setDoc } from 'firebase/firestore'
import { labDoc } from '../../../lib/db'
import { useLiveDoc } from '../../../hooks/useLive'
import { DEFAULT_QC_SETTINGS, type QcSettings } from '../types'

// QC options live on the lab document (field qcSettings); writing needs an admin.
export function useQcSettings() {
  const { data, loading } = useLiveDoc<{ qcSettings?: Partial<QcSettings> }>(labDoc(), [])
  const stored = data?.qcSettings
  const settings = useMemo(() => ({ ...DEFAULT_QC_SETTINGS, ...(stored ?? {}) }) as QcSettings, [stored])
  return { settings, loading }
}
export const saveQcSettings = (s: QcSettings) => setDoc(labDoc(), { qcSettings: s }, { merge: true })
