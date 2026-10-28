import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Checkbox, DatePicker, Empty, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { addDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import { col } from '../../../lib/db'
import { useAuth } from '../../../auth/AuthProvider'
import { useCatalogueMaps } from '../../../hooks/useCatalogue'
import { evaluateRun, paramsFor, targetFor, targetVersionOf, type Entry } from '../lib/runEval'
import { stripUndefined } from '../lib/clean'
import { useQcSettings } from '../lib/useQcSettings'
import { INVESTIGATION_CHECKLIST, OUTLIER_NATURE, PATIENT_IMPACT } from '../lib/capaOptions'
import { fmt } from '../lib/stats'
import { QC, type Capa, type QcRun as QcRunDoc, type QcLevel, type QcMaterial, type QcRun, type QcRunResult } from '../types'
import CapaModal from './CapaModal'
import { FieldGrid, FormSection } from '../../../design/FormLayout'
import { lotUsable } from '../lib/lot'
import { paramName, StatusTag, useCapas, useMachines, useMaterials, useRecentRuns } from './shared'
import { occurrenceStatus, slotViews, syncOccurrences, type SlotView } from '../lib/occurrences'
import { useBranchScope } from '../../../lib/branchScope'
import { branchStamp } from '../../../lib/activeBranch'
import { Panel } from '../ui'
import { Button as DsButton } from '../../../design/Button'

const { Text } = Typography

interface Row {
  key: string
  testId: string
  paramKey: string
}

const zColor = (z: number | undefined) => {
  if (z == null || !Number.isFinite(z)) return undefined
  const a = Math.abs(z)
  return a > 3 ? 'var(--c-urgent-wash)' : a > 2 ? 'var(--c-caution-wash)' : 'var(--c-success-wash)'
}

export default function RunSection() {
  const { message, modal } = App.useApp()
  const { user, profile } = useAuth()
  const maps = useCatalogueMaps()
  const { data: machines } = useMachines()
  const { data: materials } = useMaterials()
  const { data: recent } = useRecentRuns()
  const { data: capas } = useCapas()
  const scope = useBranchScope()
  const [machineId, setMachineId] = useState<string>()
  const [materialId, setMaterialId] = useState<string>()
  const [values, setValues] = useState<Record<string, number | null>>({})
  const { settings } = useQcSettings()
  const [note, setNote] = useState('')
  const [when, setWhen] = useState<Dayjs | null>(null) // empty = now
  const [lateReason, setLateReason] = useState('')
  const [outlier, setOutlier] = useState<NonNullable<QcRunDoc['outlier']>>({})
  const [saving, setSaving] = useState(false)
  const [capa, setCapa] = useState<Partial<Capa> | null>(null)
  const at = useRef(Date.now())

  const machine = machines.find((m) => m.id === machineId)
  const usable = materials.filter((m) => lotUsable(m))
  const material: QcMaterial | undefined = usable.find((m) => m.id === materialId)

  // Rows: parameters of the lot that this machine runs (machine-specific targets win over lot-wide ones).
  const rows: Row[] = useMemo(() => (material ? paramsFor(material, machine?.id, machine?.testIds) : []), [material, machine])
  const levels = useMemo(() => (material?.levels ?? []).slice(0, settings.levelCount), [material, settings.levelCount])

  const entries: Entry[] = useMemo(() => {
    const out: Entry[] = []
    for (const r of rows)
      for (const lv of levels) {
        const v = values[`${r.key}|${lv}`]
        if (v != null && material && targetFor(material, machine?.id, r.testId, r.paramKey, lv)) out.push({ testId: r.testId, paramKey: r.paramKey, level: lv, value: v })
      }
    return out
  }, [rows, values, material, machine, levels])

  const history = useMemo(() => recent.filter((r) => r.machineId === machineId), [recent, machineId])
  const runAtMs = when ? when.valueOf() : at.current
  const late = !!when && Date.now() - when.valueOf() > 5 * 60 * 1000
  const ev = useMemo(() => (material && entries.length ? evaluateRun(material, history, entries, runAtMs, { machineId: machine?.id, settings }) : null), [material, history, entries, runAtMs, machine, settings])

  // The scheduled slot this run would satisfy: the slot of this machine (and kit) whose window holds the run time.
  const slotFor = useMemo<SlotView | undefined>(() => {
    if (!machine || !material) return undefined
    const day = dayjs(runAtMs)
    const views = slotViews([machine], recent, capas, day.subtract(1, 'day'), day, { graceMinutes: settings.graceMinutes ?? 30, shifts: settings.shifts, matchWindowHours: settings.matchWindowHours ?? 24 }, Date.now())
      .filter((v) => (!v.slot.schedule.materialId || v.slot.schedule.materialId === material.id) && runAtMs >= v.slot.windowFrom && runAtMs <= v.slot.windowTo && v.status !== 'notApplicable')
    // Prefer a slot with no run yet, then the closest in time.
    const open = views.filter((v) => !v.run)
    const pool = open.length ? open : views
    return pool.sort((a, b) => Math.abs(a.slot.dueAt - runAtMs) - Math.abs(b.slot.dueAt - runAtMs))[0]
  }, [machine, material, recent, capas, runAtMs, settings])
  // IN_PROGRESS: the first entered value moves the open slot out of SCHEDULED / MISSED (best effort).
  const startedSlot = useRef('')
  useEffect(() => {
    if (!slotFor || slotFor.run || !entries.length || startedSlot.current === slotFor.slot.id) return
    startedSlot.current = slotFor.slot.id
    void syncOccurrences([{ ...slotFor, status: 'inProgress' }], new Map(), scope.branchId).catch(() => undefined)
  }, [slotFor, entries.length, scope.branchId])

  const reset = () => {
    setValues({})
    setNote('')
    setWhen(null)
    setLateReason('')
    setOutlier({})
    at.current = Date.now()
  }

  const save = async () => {
    if (!machine || !material || !ev || !entries.length) return
    if (late && !lateReason.trim()) {
      message.warning('A back-dated run needs a reason')
      return
    }
    if (when && when.isAfter(dayjs())) {
      message.warning('The run time cannot be in the future')
      return
    }
    const extreme = entries.find((e) => Math.abs(ev.z[`${e.testId}|${e.paramKey}|${e.level}`]) > 10)
    if (extreme && !(await new Promise<boolean>((res) => modal.confirm({ title: 'Possible entry error', content: 'A value is more than 10 SD from its target. Save anyway?', onOk: () => res(true), onCancel: () => res(false) })))) return
    // A slot that already has a run: warn before recording a second one for the same schedule and period.
    if (slotFor?.run && !(await new Promise<boolean>((res) => modal.confirm({ title: 'QC already recorded for this slot', content: `${slotFor.slot.machine.name} ${slotFor.slot.slotLabel} on ${dayjs(slotFor.slot.dueAt).format('DD MMM')} already has run ${slotFor.run?.runNo ?? ''}. Save another run anyway?`, okText: 'Save another', onOk: () => res(true), onCancel: () => res(false) })))) return
    const results: QcRunResult[] = entries.map((e) => ({
      testId: e.testId,
      testName: maps.testById.get(e.testId)?.name ?? '',
      paramKey: e.paramKey,
      paramName: paramName(maps.testById.get(e.testId), e.paramKey),
      level: e.level,
      value: e.value,
      z: Number(ev.z[`${e.testId}|${e.paramKey}|${e.level}`].toFixed(3)),
      mean: ev.snapshot[`${e.testId}|${e.paramKey}|${e.level}`]?.mean,
      sd: ev.snapshot[`${e.testId}|${e.paramKey}|${e.level}`]?.sd,
      targetVersion: targetVersionOf(material),
      outcome: ev.violations.some((v) => v.testId === e.testId && v.paramKey === e.paramKey && v.severity === 'fail') ? 'fail' : ev.violations.some((v) => v.testId === e.testId && v.paramKey === e.paramKey) ? 'warning' : 'pass',
    }))
    const day = dayjs(when ?? undefined).format('YYMMDD')
    const sameDay = recent.filter((r) => r.runNo?.startsWith(`QC-${day}-`)).length
    const runNo = `QC-${day}-${String(sameDay + 1).padStart(3, '0')}`
    setSaving(true)
    try {
      const doc = {
        machineId: machine.id,
        machineName: machine.name,
        departmentId: machine.departmentId ?? '',
        materialId: material.id,
        materialName: material.name,
        lotNo: material.lotNo,
        results,
        status: ev.status,
        violations: ev.violations,
        note,
        runBy: user?.uid ?? '',
        runByName: profile?.name ?? '',
        runAt: when ? Timestamp.fromDate(when.toDate()) : serverTimestamp(),
        runNo,
        targetVersion: targetVersionOf(material),
        ...(slotFor && !slotFor.run ? { scheduleId: slotFor.slot.schedule.id, occurrenceId: slotFor.slot.id } : {}),
        approval: settings.approvalEnabled ? 'pending' : 'notRequired',
        deleted: false,
        ...(late ? { late: true, lateReason: lateReason.trim() } : {}),
        ...(ev.violations.length ? { outlier: cleanOutlier(outlier) } : {}),
      }
      const ref = await addDoc(col<Omit<QcRun, 'id'>>(QC.runs), stripUndefined({ ...branchStamp(), ...doc }) as never)
      message.success(`QC run ${runNo} saved: ${ev.status}`)
      if (slotFor && !slotFor.run) {
        const fake = { id: ref.id, runNo, status: ev.status, approval: settings.approvalEnabled ? 'pending' : 'notRequired', machineId: machine.id, materialId: material.id, deleted: false } as QcRun
        const st = occurrenceStatus(slotFor.slot, fake, [], false, Date.now())
        void syncOccurrences([{ slot: slotFor.slot, run: fake, status: st }], new Map(), scope.branchId).catch(() => undefined)
      }
      const m = machine
      const failed = ev.violations.filter((v) => v.severity === 'fail')
      const prefill: Partial<Capa> = {
        runId: ref.id,
        machineId: m.id,
        machineName: m.name,
        sourceType: 'iqc',
        sourceId: ref.id,
        cause: failed.map((v) => `${v.rule} on ${maps.testById.get(v.testId)?.name ?? ''}/${paramName(maps.testById.get(v.testId), v.paramKey)}: ${v.message}`).join('\n'),
        outlierNature: outlier.nature,
        investigation: outlier.checklist,
        remedialAction: outlier.remedial,
        followUp: outlier.followUp,
        patientImpactAssessed: outlier.patientImpact === 'reviewed' || outlier.patientImpact === 'repeat',
      }
      reset()
      // A rejected run needs corrective action: the prompt has no "later" button when CAPA is on.
      if (ev.status === 'fail' && settings.capa) {
        modal.info({
          title: 'QC run failed',
          content: 'This run is rejected. Record the corrective and preventive action (CAPA) now; the run cannot be approved without one.',
          okText: 'Raise corrective action',
          onOk: () => setCapa(prefill),
        })
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Panel size="small" style={{ marginBottom: 16 }}>
        <FieldGrid min={260}>
          <Form.Item label="Machine" style={{ marginBottom: 0 }}>
            <Select
              style={{ width: '100%' }}
              aria-label="Machine"
              placeholder="Machine"
              value={machineId}
              onChange={(v) => {
                setMachineId(v)
                reset()
              }}
              options={machines.filter((m) => m.active !== false).map((m) => ({ value: m.id, label: m.name }))}
            />
          </Form.Item>
          <Form.Item label="Material / lot" style={{ marginBottom: 0 }}>
            <Select
              style={{ width: '100%' }}
              aria-label="Material / lot"
              placeholder="Material / lot (non-expired)"
              value={materialId}
              onChange={(v) => {
                setMaterialId(v)
                reset()
              }}
              options={usable.map((m) => ({ value: m.id, label: `${m.name} - lot ${m.lotNo}` }))}
            />
          </Form.Item>
        </FieldGrid>
        {slotFor && (
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">
              {slotFor.run ? `This slot (${slotFor.slot.slotLabel}) already has run ${slotFor.run.runNo ?? ''}.` : `This run will satisfy the scheduled slot ${slotFor.slot.slotLabel} on ${dayjs(slotFor.slot.dueAt).format('DD MMM')}.`}
            </Text>
          </div>
        )}
      </Panel>

      {!machine || !material ? (
        <Empty description="Pick a machine and a QC lot to start a run" />
      ) : rows.length === 0 ? (
        <Alert type="warning" showIcon message="This lot has no targets for the tests this machine runs." />
      ) : (
        <>
          <Table<Row>
            size="small"
            pagination={false}
            rowKey="key"
            dataSource={rows}
            columns={[
              { title: 'Test', render: (_, r) => maps.testById.get(r.testId)?.name ?? r.testId },
              { title: 'Parameter', render: (_, r) => paramName(maps.testById.get(r.testId), r.paramKey) },
              ...levels.map((lv: QcLevel) => ({
                title: lv,
                width: 220,
                render: (_: unknown, r: Row) => {
                  const t = targetFor(material, machine.id, r.testId, r.paramKey, lv)
                  if (!t) return <Text type="secondary">-</Text>
                  const k = `${r.key}|${lv}`
                  const z = ev?.z[k]
                  return (
                    <Space vertical size={2}>
                      <Space size={6}>
                        <InputNumber
                          style={{ width: 110, background: values[k] != null ? zColor(z) : undefined }}
                          value={values[k] ?? null}
                          onChange={(v) => setValues({ ...values, [k]: v })}
                          status={z != null && Math.abs(z) > 3 ? 'error' : z != null && Math.abs(z) > 2 ? 'warning' : undefined}
                        />
                        <Text strong style={{ minWidth: 56 }}>
                          {values[k] != null ? `z ${fmt(z)}` : ''}
                        </Text>
                      </Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        target {t.mean} ± {t.sd}
                      </Text>
                    </Space>
                  )
                },
              })),
            ]}
          />
          <Panel size="small" style={{ marginTop: 16 }} title="Westgard evaluation">
            {!ev ? (
              <Text type="secondary">Enter values to see the evaluation.</Text>
            ) : (
              <Space vertical style={{ width: '100%' }}>
                <Space>
                  <Text>Overall:</Text>
                  <StatusTag status={ev.status} />
                  <Text type="secondary">against the last {history.length ? 'runs of this machine and lot' : 'runs (no history yet)'}</Text>
                </Space>
                {ev.violations.map((v, i) => (
                  <Alert
                    key={i}
                    type={v.severity === 'fail' ? 'error' : 'warning'}
                    showIcon
                    message={
                      <span>
                        <Tag>{v.rule}</Tag>
                        {maps.testById.get(v.testId)?.name} / {paramName(maps.testById.get(v.testId), v.paramKey)}: {v.message}
                      </span>
                    }
                  />
                ))}
                {ev.violations.length === 0 && <Text type="success">No rule violations.</Text>}
              </Space>
            )}
            {ev && ev.violations.length > 0 && (settings.outlierNature || settings.investigationChecklist || settings.remedialAction || settings.rootCauseAnalysis || settings.patientResultManagement || settings.followUp) && (
              <FormSection title="Outlier investigation" description="Record what you found for this failed run.">
                <Form layout="vertical" component="div">
                  <FieldGrid min={280}>
                    {settings.outlierNature && <Form.Item label="Nature of QC outlier"><Select allowClear aria-label="Nature of QC outlier" placeholder="Nature of QC outlier" style={{ width: '100%' }} value={outlier.nature} onChange={(v) => setOutlier({ ...outlier, nature: v })} options={OUTLIER_NATURE} /></Form.Item>}
                    {settings.patientResultManagement && <Form.Item label="Patient result management"><Select allowClear aria-label="Patient result management" placeholder="Patient result management" style={{ width: '100%' }} value={outlier.patientImpact} onChange={(v) => setOutlier({ ...outlier, patientImpact: v })} options={PATIENT_IMPACT} /></Form.Item>}
                  </FieldGrid>
                  {settings.investigationChecklist && <Form.Item label="Investigation checklist"><Checkbox.Group className="qc-checkgrid" style={{ minWidth: 0 }} value={outlier.checklist ?? []} onChange={(v) => setOutlier({ ...outlier, checklist: v as string[] })} options={INVESTIGATION_CHECKLIST} /></Form.Item>}
                  <FieldGrid min={280}>
                    {settings.rootCauseAnalysis && <Form.Item label="Root cause analysis"><Input.TextArea rows={2} value={outlier.rca} onChange={(e) => setOutlier({ ...outlier, rca: e.target.value })} /></Form.Item>}
                    {settings.remedialAction && <Form.Item label="Remedial action taken"><Input.TextArea rows={2} value={outlier.remedial} onChange={(e) => setOutlier({ ...outlier, remedial: e.target.value })} /></Form.Item>}
                    {settings.followUp && <Form.Item label="Follow-up steps"><Input.TextArea rows={2} value={outlier.followUp} onChange={(e) => setOutlier({ ...outlier, followUp: e.target.value })} /></Form.Item>}
                  </FieldGrid>
                </Form>
              </FormSection>
            )}
            <FormSection title="Run details">
              <Form layout="vertical" component="div">
                <FieldGrid min={260}>
                  <Form.Item label="Run date and time" extra="Leave empty to use now.">
                    <DatePicker showTime allowClear style={{ width: '100%' }} placeholder="Now" value={when} onChange={setWhen} disabledDate={(d) => d.isAfter(dayjs(), 'day')} aria-label="Run date and time" />
                  </Form.Item>
                  {late && (
                    <Form.Item label="Reason for back-dated entry" required extra={<Tag color="gold">Late entry</Tag>}>
                      <Input aria-label="Reason for back-dated entry" placeholder="Required" value={lateReason} onChange={(e) => setLateReason(e.target.value)} />
                    </Form.Item>
                  )}
                </FieldGrid>
                <Form.Item label="Comment">
                  <Input.TextArea rows={2} placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
                </Form.Item>
              </Form>
            </FormSection>
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <DsButton variant="primary" icon={<SaveOutlined />} disabled={!entries.length || saving} onClick={save}>
                Save QC run
              </DsButton>
            </div>
          </Panel>
        </>
      )}
      <CapaModal open={!!capa} initial={capa} onClose={() => setCapa(null)} />
    </>
  )
}

const cleanOutlier = (o: NonNullable<QcRunDoc['outlier']>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)))
