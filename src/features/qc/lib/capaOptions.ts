// Option lists for the failed-run / CAPA forms (used when the matching QC setting is on).
export const OUTLIER_NATURE = [
  { value: 'random', label: 'Random error' },
  { value: 'systematic', label: 'Systematic error (shift or trend)' },
  { value: 'unknown', label: 'Not yet known' },
]
export const INVESTIGATION_CHECKLIST = [
  'Control material stored and handled correctly',
  'Control not expired / lot number correct',
  'Reagent in date and loaded correctly',
  'Calibration valid',
  'Instrument maintenance and probes checked',
  'Sample / control pipetting or mixing checked',
  'Temperature and environment in range',
]
export const ROOT_CAUSE_CATEGORIES = [
  { value: 'reagent', label: 'Reagent' },
  { value: 'calibration', label: 'Calibration' },
  { value: 'control', label: 'Control material' },
  { value: 'instrument', label: 'Instrument / maintenance' },
  { value: 'operator', label: 'Operator / technique' },
  { value: 'environment', label: 'Environment' },
  { value: 'other', label: 'Other' },
]
export const PATIENT_IMPACT = [
  { value: 'none', label: 'No patient results affected' },
  { value: 'reviewed', label: 'Patient results since last good QC reviewed' },
  { value: 'repeat', label: 'Affected patient results repeated or corrected' },
]
export const CAPA_STATUS = [
  { value: 'open', label: 'Open' },
  { value: 'actionTaken', label: 'Action taken' },
  { value: 'verified', label: 'Verified (repeat run passed)' },
  { value: 'closed', label: 'Closed' },
]
