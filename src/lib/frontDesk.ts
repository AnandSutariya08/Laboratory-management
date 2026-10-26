import { useMemo } from 'react'
import { useLabSettings } from '../hooks/useCatalogue'
import type { CustomFieldDef, FrontDeskSettings } from '../types'

// Front-desk configuration (field labels, add-on fields, refund approval, serviceable pincodes).
export function useFrontDesk(): FrontDeskSettings & { label: (key: string, fallback: string) => string; customFields: CustomFieldDef[]; bookingFields: CustomFieldDef[] } {
  const fd = useLabSettings().frontDesk
  return useMemo(() => {
    const labels = fd?.fieldLabels ?? {}
    return {
      ...(fd ?? {}),
      customFields: fd?.customFields ?? [],
      bookingFields: fd?.bookingFields ?? [],
      label: (key: string, fallback: string) => (labels[key]?.trim() ? labels[key].trim() : fallback),
    }
  }, [fd])
}

// True when the pincode is outside the serviceable list. An empty list means every pincode is served.
export function pincodeUnserviceable(pincode: string | undefined, list: string[] | undefined): boolean {
  const p = (pincode ?? '').trim()
  if (!p || !list || list.length === 0) return false
  return !list.map((x) => x.trim()).includes(p)
}
