import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { App, Checkbox, Input, Slider, Switch } from 'antd'
import { PrinterOutlined } from '@ant-design/icons'
import { updateDoc } from 'firebase/firestore'
import { labDoc } from '../../lib/db'
import { useLiveDoc } from '../../hooks/useLive'
import { useLabSettings } from '../../hooks/useCatalogue'
import { PageHeader } from '../../design/PageHeader'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { Segmented } from '../../design/Segmented'
import { SkeletonCard } from '../../design/Skeletons'
import SmartPages, { type SmartModel } from './SmartPages'
import {
  CARD_STYLES,
  COVER_FIELD_LABEL,
  COVER_STYLES,
  FONT_STYLES,
  mergeSmart,
  THEMES,
  THEME_OPTIONS,
  type CoverField,
  type CoverStyle,
  type SmartReportSettings,
} from './types'
import './smartReport.css'

// Sample bill for the live preview (made-up values, never saved).
const SAMPLE: SmartModel = {
  cover: { name: 'Asha Verma', ageGender: '34 years / Female', patientId: '260101001', billNo: 'HCL1042', referrer: 'Dr. R. Menon', date: '16 Oct 2026' },
  firstName: 'Asha',
  items: [
    { key: 'hb', testName: 'Complete Blood Count', name: 'Haemoglobin', value: '10.8', unit: 'g/dL', num: 10.8, flag: 'low', critical: false, range: '12.0 - 15.5', low: 12, high: 15.5, note: 'Haemoglobin carries oxygen in your blood. A low level can make you feel tired. Your doctor may check your iron levels.', system: 'blood' },
    { key: 'wbc', testName: 'Complete Blood Count', name: 'White blood cells', value: '7200', unit: '/cumm', num: 7200, flag: null, critical: false, range: '4000 - 11000', low: 4000, high: 11000, note: 'Within the usual range.', system: 'blood' },
    { key: 'plt', testName: 'Complete Blood Count', name: 'Platelets', value: '2.6', unit: 'lakh/cumm', num: 2.6, flag: null, critical: false, range: '1.5 - 4.1', low: 1.5, high: 4.1, note: 'Within the usual range.', system: 'blood' },
    { key: 'fbs', testName: 'Glucose Fasting', name: 'Fasting glucose', value: '126', unit: 'mg/dL', num: 126, flag: 'high', critical: false, range: '70 - 100', low: 70, high: 100, note: 'Your fasting sugar is higher than usual. Your doctor may suggest an HbA1c test and changes to diet and activity.', system: 'sugar' },
    { key: 'ldl', testName: 'Lipid Profile', name: 'LDL cholesterol', value: '96', unit: 'mg/dL', num: 96, flag: null, critical: false, range: '< 100', low: null, high: 100, note: 'Within the usual range.', system: 'heart' },
    { key: 'hdl', testName: 'Lipid Profile', name: 'HDL cholesterol', value: '52', unit: 'mg/dL', num: 52, flag: null, critical: false, range: '> 40', low: 40, high: null, note: 'Within the usual range.', system: 'heart' },
    { key: 'tsh', testName: 'Thyroid Profile', name: 'TSH', value: '2.1', unit: 'µIU/mL', num: 2.1, flag: null, critical: false, range: '0.4 - 4.0', low: 0.4, high: 4, note: 'Within the usual range.', system: 'thyroid' },
    { key: 'cr', testName: 'Kidney Function Test', name: 'Creatinine', value: '0.8', unit: 'mg/dL', num: 0.8, flag: null, critical: false, range: '0.6 - 1.1', low: 0.6, high: 1.1, note: 'Within the usual range.', system: 'kidney' },
    { key: 'd3', testName: 'Vitamin D', name: 'Vitamin D (25-OH)', value: '18', unit: 'ng/mL', num: 18, flag: 'low', critical: false, range: '30 - 100', low: 30, high: 100, note: 'Vitamin D helps keep bones strong. Sunlight and supplements advised by your doctor can raise it.', system: 'vitamins' },
  ],
  trends: [
    { key: 'hbtrend', name: 'Haemoglobin', unit: 'g/dL', low: 12, high: 15.5, data: [{ label: 'Jan 26', v: 11.9 }, { label: 'Apr 26', v: 11.2 }, { label: 'Jul 26', v: 11.0 }, { label: 'This report', v: 10.8 }] },
    { key: 'fbstrend', name: 'Fasting glucose', unit: 'mg/dL', low: 70, high: 100, data: [{ label: 'Jan 26', v: 104 }, { label: 'Apr 26', v: 112 }, { label: 'Jul 26', v: 119 }, { label: 'This report', v: 126 }] },
  ],
  doctorNote: 'Please start the iron and vitamin D supplements as discussed and repeat the blood count in 3 months. Keep a check on sweets and walk daily.',
  ai: [],
}

// Tiny cover thumbnails for the layout picker.
function CoverThumb({ style, c, d }: { style: CoverStyle; c: string; d: string }) {
  const g = `linear-gradient(140deg, ${c}, ${d})`
  const bar = (top: number, w: number, col = '#cbd5e1') => <i style={{ left: 10, top, width: w, height: 4, borderRadius: 2, background: col }} />
  if (style === 'gradient' || style === 'wave') return <div className="sr-thumb"><i style={{ inset: 0, height: 34, background: g, borderRadius: style === 'wave' ? '0 0 50% 20% / 0 0 30% 20%' : 0 }} /><i style={{ left: 10, top: 28, right: 10, height: 26, background: '#fff', borderRadius: 6, boxShadow: '0 2px 6px #0002' }} /></div>
  if (style === 'band') return <div className="sr-thumb"><i style={{ left: 0, right: 0, top: 0, height: 20, background: g }} />{bar(30, 50, c)}{bar(40, 70)}{bar(48, 60)}</div>
  if (style === 'split') return <div className="sr-thumb"><i style={{ left: 0, top: 0, bottom: 0, width: 26, background: g }} /><i style={{ left: 34, top: 18, width: 50, height: 5, borderRadius: 2, background: c }} /><i style={{ left: 34, top: 30, width: 60, height: 4, borderRadius: 2, background: '#cbd5e1' }} /></div>
  if (style === 'frame') return <div className="sr-thumb"><i style={{ inset: 6, border: `2px solid ${c}`, borderRadius: 6 }} /><i style={{ left: '30%', top: 22, width: '40%', height: 5, borderRadius: 2, background: c }} /><i style={{ left: '25%', top: 34, width: '50%', height: 4, borderRadius: 2, background: '#cbd5e1' }} /></div>
  return <div className="sr-thumb">{bar(24, 70, '#0f172a')}<i style={{ left: 10, top: 34, width: 24, height: 3, background: c }} />{bar(44, 56)}</div>
}
const MAX_LOGO = 200 * 1024
const MAX_LH = 300 * 1024

// Downscale a letterhead image on a canvas until it fits the size cap.
function compressImage(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      let w = Math.min(img.width, 1240)
      let q = 0.85
      for (let i = 0; i < 8; i++) {
        const c = document.createElement('canvas')
        c.width = w
        c.height = Math.round((img.height * w) / img.width)
        const ctx = c.getContext('2d')
        if (!ctx) return reject(new Error('Image not supported'))
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.drawImage(img, 0, 0, c.width, c.height)
        const out = c.toDataURL('image/jpeg', q)
        if (out.length <= maxBytes * 1.37) return resolve(out)
        w = Math.round(w * 0.8)
        q = Math.max(0.5, q - 0.08)
      }
      reject(new Error('Could not shrink the image under 300 KB'))
    }
    img.onerror = () => reject(new Error('Could not read the image'))
    img.src = url
  })
}

export default function SmartReportPage() {
  const { message } = App.useApp()
  const lab = useLabSettings()
  const { data, loading } = useLiveDoc<{ smartReport?: unknown }>(labDoc(), [])
  const [s, setS] = useState<SmartReportSettings | null>(null)
  const [tab, setTab] = useState<'cover' | 'layout'>('cover')
  const [saving, setSaving] = useState(false)
  const [zoom, setZoom] = useState(60)

  useEffect(() => {
    if (loading || s) return
    const m = mergeSmart(data?.smartReport)
    setS({ ...m, labName: m.labName || lab.name, labAddress: m.labAddress || lab.address, logoDataUrl: m.logoDataUrl || lab.profile.logoDataUrl, email: m.email || lab.email })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, data])

  if (!s) return <SkeletonCard lines={6} />
  const set = <K extends keyof SmartReportSettings>(k: K, v: SmartReportSettings[K]) => setS((cur) => (cur ? { ...cur, [k]: v } : cur))

  const onLogo = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return message.error('Choose an image file')
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      if (url.length > MAX_LOGO * 1.37) return message.error('Logo is larger than 200 KB. Use a smaller image (about 595 x 80 px).')
      set('logoDataUrl', url)
    }
    r.readAsDataURL(file)
  }

  const onLetterhead = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return message.error('Choose an image file')
    try {
      set('letterheadDataUrl', await compressImage(file, MAX_LH))
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not use this image')
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      await updateDoc(labDoc(), { smartReport: s })
      message.success('Smart report settings saved')
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const Toggle = ({ label, k }: { label: string; k: 'showHistoryGraph' | 'showDoctorNote' | 'showAiTag' | 'showWellness' | 'smartReportLink' | 'includeOriginal' | 'showSummaryCounts' | 'showRangeBar' | 'showHealthScore' | 'showAllResults' | 'showPageHeader' }) => (
    <div className="sr-toggle"><span id={`sr-${k}`}>{label}</span><Switch aria-labelledby={`sr-${k}`} checked={s[k]} onChange={(v) => set(k, v)} /></div>
  )

  return (
    <div>
      <PageHeader
        title="Smart report"
        subtitle="Design the patient-friendly report. Open any bill's report and choose Smart report to generate it."
        actions={<Button variant="primary" disabled={saving} onClick={save}>Save</Button>}
      />
      <div className="sr-bar">
        <Segmented<'cover' | 'layout'> aria-label="Designer section" value={tab} onChange={setTab} options={[{ value: 'cover', label: 'Cover and style' }, { value: 'layout', label: 'Pages and sections' }]} />
        <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print sample</Button>
        <div className="sr-zoom"><span id="sr-zoom-l">Preview size</span><Slider aria-labelledby="sr-zoom-l" min={35} max={100} step={5} value={zoom} onChange={setZoom} style={{ width: 160 }} /><span>{zoom}%</span></div>
      </div>
      <div className="sr-layout">
        <Card as="section" aria-label="Designer settings">
          <div className="sr-form">
            {tab === 'cover' ? (
              <>
                <div className="sr-field">
                  <label htmlFor="sr-logo">Logo (about 595 x 80 px, up to 200 KB)</label>
                  <input id="sr-logo" type="file" accept="image/*" onChange={(e) => onLogo(e.target.files?.[0])} />
                  {s.logoDataUrl && <Button onClick={() => set('logoDataUrl', '')}>Remove logo</Button>}
                </div>
                <div className="sr-field">
                  <label htmlFor="sr-lab">Lab name</label>
                  <Input id="sr-lab" value={s.labName} onChange={(e) => set('labName', e.target.value)} />
                </div>
                <div className="sr-field">
                  <label htmlFor="sr-addr">Lab address</label>
                  <Input.TextArea id="sr-addr" rows={3} value={s.labAddress} onChange={(e) => set('labAddress', e.target.value)} />
                </div>
                <div className="sr-field">
                  <label htmlFor="sr-title">Cover title</label>
                  <Input id="sr-title" maxLength={40} value={s.coverTitle} onChange={(e) => set('coverTitle', e.target.value)} />
                </div>
                <div className="sr-field">
                  <label htmlFor="sr-sub">Cover subtitle</label>
                  <Input id="sr-sub" maxLength={90} value={s.coverSubtitle} onChange={(e) => set('coverSubtitle', e.target.value)} />
                </div>
                <div className="sr-field">
                  <label id="sr-style-l">Cover design</label>
                  <div className="sr-styles" role="group" aria-labelledby="sr-style-l">
                    {COVER_STYLES.map((c) => (
                      <button key={c.value} type="button" className="sr-style press" aria-pressed={s.coverStyle === c.value} onClick={() => set('coverStyle', c.value)}>
                        <CoverThumb style={c.value} c={THEMES[s.themeColour].main} d={THEMES[s.themeColour].deep} />
                        <b>{c.label}</b>
                        <small>{c.hint}</small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sr-field">
                  <label id="sr-theme-l">Theme colour</label>
                  <div className="sr-swatches" role="group" aria-labelledby="sr-theme-l">
                    {THEME_OPTIONS.map((t) => (
                      <button key={t.value} type="button" className="sr-swatch press" style={{ background: `linear-gradient(140deg, ${THEMES[t.value].main}, ${THEMES[t.value].deep})` }} aria-pressed={s.themeColour === t.value} onClick={() => set('themeColour', t.value)}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sr-field">
                  <span className="sr-field__label" id="sr-font-l">Font style</span>
                  <Segmented aria-label="Font style" value={s.fontStyle} onChange={(v) => set('fontStyle', v)} options={FONT_STYLES.map((f) => ({ value: f.value, label: f.label }))} />
                </div>
                <div className="sr-field">
                  <span className="sr-field__label">Card style</span>
                  <Segmented aria-label="Card style" value={s.cardStyle} onChange={(v) => set('cardStyle', v)} options={CARD_STYLES.map((f) => ({ value: f.value, label: f.label }))} />
                </div>
                <div className="sr-field">
                  <label htmlFor="sr-lh">Letterhead image (compressed to 300 KB, used behind the cover and page headers)</label>
                  <input id="sr-lh" type="file" accept="image/*" onChange={(e) => onLetterhead(e.target.files?.[0])} />
                  {s.letterheadDataUrl && <Button onClick={() => set('letterheadDataUrl', '')}>Remove letterhead</Button>}
                </div>
                <div className="sr-field">
                  <small>The doctor signature on the original report comes from <Link to="/settings">Signatories in Settings</Link>.</small>
                </div>
                <Toggle label="Show the AI generated tag on the cover" k="showAiTag" />
                <div className="sr-field">
                  <label id="sr-fields-l">Fields on the cover</label>
                  <Checkbox.Group
                    aria-labelledby="sr-fields-l"
                    value={s.coverFields}
                    onChange={(v) => set('coverFields', v as CoverField[])}
                    options={(Object.keys(COVER_FIELD_LABEL) as CoverField[]).map((k) => ({ value: k, label: COVER_FIELD_LABEL[k] }))}
                    style={{ display: 'grid', gap: 6 }}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="sr-field">
                  <label htmlFor="sr-email">Email address shown on each page</label>
                  <Input id="sr-email" type="email" value={s.email} onChange={(e) => set('email', e.target.value)} />
                </div>
                <div className="sr-field">
                  <label htmlFor="sr-foot">Footer text (80 characters)</label>
                  <Input id="sr-foot" maxLength={80} showCount value={s.footerText} onChange={(e) => set('footerText', e.target.value)} />
                </div>
                <Toggle label="Page header with lab name on every page" k="showPageHeader" />
                <Toggle label="Health score ring" k="showHealthScore" />
                <Toggle label="Body systems overview" k="showWellness" />
                <Toggle label="All results page, grouped by body system" k="showAllResults" />
                <Toggle label="Test history graph" k="showHistoryGraph" />
                <Toggle label="Doctor's note" k="showDoctorNote" />
                <Toggle label="Summary counts (normal, abnormal, critical)" k="showSummaryCounts" />
                <Toggle label="Range bar for numeric values" k="showRangeBar" />
                <Toggle label="Append the original signed report" k="includeOriginal" />
                <Toggle label="Offer the smart report link by default when sending" k="smartReportLink" />
                <div className="sr-field">
                  <label htmlFor="sr-disc">Disclaimer</label>
                  <Input.TextArea id="sr-disc" rows={5} value={s.disclaimer} onChange={(e) => set('disclaimer', e.target.value)} />
                </div>
              </>
            )}
          </div>
        </Card>
        <div className="sr-previewbox" aria-label="Live preview">
          <div style={{ zoom: zoom / 100 }}>
            <SmartPages s={s} model={SAMPLE} aiTag={s.showAiTag} />
          </div>
        </div>
      </div>
    </div>
  )
}
