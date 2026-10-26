import { useMemo } from 'react'
import { AutoComplete, Checkbox, Input, Popover, Select, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  AlertOutlined,
  CheckOutlined,
  CommentOutlined,
  EditOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  LineChartOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  RollbackOutlined,
  ReloadOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  StopOutlined,
  UndoOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import type { Timestamp } from 'firebase/firestore'
import { Card } from '../../design/Card'
import { Button } from '../../design/Button'
import { StatusChip } from '../../design/StatusChip'
import { deltaCheck, dlcOff, dlcTotal, flagLetter, hasAnyValue, rangeTextFor, type DeltaCfg } from '../../lib/results'
import type { ParamValue, Parameter, Test } from '../../types'
import type { TestQc } from '../../features/qc/lib/useQcStatus'
import { fmtDateTime, ITEM_LABEL, ITEM_VARIANT, tsToDate } from './common'
import { ISSUE_LABEL, machineRuns, type ResultExt, type Values } from './types'
import { FileInput, RichEditor } from './ParamInputs'
import { deltaPct } from './resultOps'

export interface Prev {
  values: Values
  date: Timestamp
  billNo: string
}

interface Row {
  key: string
  p?: Parameter
  header?: string
  indent?: boolean
}

const CHANNEL: Record<string, string> = { phone: 'phone', inPerson: 'in person', whatsapp: 'message', other: 'other means' }

export function buildRows(params: Parameter[]): Row[] {
  const keys = new Set(params.map((p) => p.key))
  const rows: Row[] = []
  for (const p of params.filter((x) => !x.parentKey || !keys.has(x.parentKey))) {
    if (p.structure === 'group') {
      rows.push({ key: p.key, header: p.name })
      params.filter((m) => m.parentKey === p.key).forEach((m) => rows.push({ key: m.key, p: m, indent: true }))
    } else rows.push({ key: p.key, p })
  }
  return rows
}

export const FlagMark = ({ v }: { v: ParamValue | undefined }) => {
  if (!v || (!v.abnormal && !v.critical)) return null
  const word = v.critical && v.criticalDir ? (v.criticalDir === 'low' ? 'Critically low' : 'Critically high') : v.abnormal === 'high' ? 'High' : v.abnormal === 'low' ? 'Low' : 'Abnormal'
  return (
    <span className={v.critical ? 're-flag--crit' : `re-flag--${v.abnormal}`} aria-label={`${word}${v.critical && !v.criticalDir ? ', critical' : ''}`}>
      {flagLetter(v) || 'Critical'}
      {v.critical ? ' !!' : ''}
    </span>
  )
}

export interface CardProps {
  test: Test
  values: Values
  comment: string
  paramComments: Record<string, string>
  result: ResultExt | undefined
  history: Prev[]
  dirty: boolean
  ageDays: number
  gender?: string
  condition?: string // patient condition (pregnancy etc.)
  delta: DeltaCfg
  rerunBlocked?: string | null // reason a re-run is not allowed (sample discarded)
  colourRows: boolean
  abnormalOnly: boolean
  selectedParams: string[]
  canEnter: boolean
  canApprove: boolean
  canUnapprove: boolean
  qc?: TestQc
  qcReason: string | null
  amending: boolean
  onReleaseChange: (r: 'final' | 'provisional') => void // only offered once the test is approved
  onFlag: (p: Parameter, on: boolean) => void
  onEditRange: (p: Parameter) => void
  onCommentOnReport: (on: boolean) => void
  onParamCommentOnReport: (key: string, on: boolean) => void
  onAmend: () => void
  onCancelAmend: () => void
  onSendBack: () => void
  onChange: (p: Parameter, raw: string) => void
  onOverride: (p: Parameter, on: boolean) => void
  onComment: (c: string) => void
  onParamComment: (key: string, c: string) => void
  onSelectParams: (keys: string[]) => void
  onApprove: () => void
  onUnapprove: () => void
  onHold: () => void
  onRerun: () => void
  onReject: () => void
  onRestore: () => void
  onIssue: () => void
  onAddComment: () => void
  onMachine: () => void
  onVersions: () => void
  onAck: () => void
  onToggleInterpretation: (on: boolean) => void
  onInterpret?: () => void
  interpreting?: boolean
}

const fmtDur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

export default function TestCard(props: CardProps) {
  const { test, values, result, history, ageDays, gender, condition } = props
  const status = result?.status ?? 'pending'
  const locked = status === 'approved' && !props.amending
  const rejected = status === 'rejected'
  const rows = useMemo(() => {
    const all = buildRows(test.parameters)
    if (!props.abnormalOnly) return all
    return all.filter((r) => (r.p ? values[r.p.key]?.abnormal || values[r.p.key]?.critical : all.some((m) => m.p && m.indent && test.parameters.find((x) => x.key === m.key)?.parentKey === r.key && (values[m.key]?.abnormal || values[m.key]?.critical))))
  }, [test.parameters, values, props.abnormalOnly])
  const criticals = test.parameters.filter((p) => values[p.key]?.critical)
  const runs = machineRuns(result?.machineValues)
  const prev = history[0]
  const rejectedParams = result?.rejectedParams ?? []
  const interpretationOn = result?.showInterpretation !== false
  const rejectedValues = result?.rejectedValues ?? {}
  const dlc = useMemo(() => dlcTotal(test.parameters, values), [test.parameters, values])
  const deltaOn = props.delta.pct > 0 || props.delta.abs > 0 || test.parameters.some((p) => (p.deltaLimitPct ?? 0) > 0 || (p.deltaLimitAbs ?? 0) > 0)
  const heldMs = result?.holdTotalMs ?? 0

  const cell = (r: Row) => (r.header ? { colSpan: 8 } : {})
  const rest = (r: Row) => (r.header ? { colSpan: 0 } : {})

  const columns: ColumnsType<Row> = [
    {
      title: '',
      width: 36,
      onCell: cell,
      render: (_, r) =>
        r.header ? (
          <strong className="re-grp">{r.header}</strong>
        ) : (
          <Checkbox
            aria-label={`Select ${r.p!.name}`}
            checked={props.selectedParams.includes(r.p!.key)}
            onChange={(e) => props.onSelectParams(e.target.checked ? [...props.selectedParams, r.p!.key] : props.selectedParams.filter((k) => k !== r.p!.key))}
          />
        ),
    },
    {
      title: 'Parameter',
      width: 220,
      onCell: rest,
      render: (_, r) =>
        r.p ? (
          <span style={{ paddingLeft: r.indent ? 20 : 0 }}>
            {r.p.name}
            {r.p.required && <span className="re-flag--low" aria-label="required"> *</span>}
            {rejectedParams.includes(r.p.key) && <> <StatusChip variant="urgent">Rejected</StatusChip></>}
          </span>
        ) : null,
    },
    {
      title: 'Result',
      width: 300,
      onCell: rest,
      render: (_, r) => {
        if (!r.p) return null
        const p = r.p
        const v = values[p.key]
        const calc = !!p.formula
        const readOnly = locked || rejected || !props.canEnter || (calc && !v?.overridden) || rejectedParams.includes(p.key)
        const paramRejected = rejectedParams.includes(p.key)
        const struck = rejected || paramRejected
        // A rejected result keeps its value, shown struck out and read-only.
        const val = paramRejected ? rejectedValues[p.key]?.value ?? v?.value ?? '' : v?.value ?? ''
        const strong = v?.abnormal || v?.critical ? { fontWeight: 700 } : undefined
        let input
        if (p.dataType === 'options') {
          input = <AutoComplete aria-label={p.name} style={{ width: 170 }} disabled={readOnly} value={val} options={p.options.map((o) => ({ value: o }))} onChange={(x) => props.onChange(p, x)} />
        } else if (p.dataType === 'text') {
          input = <Input.TextArea aria-label={p.name} style={{ width: 200, ...strong }} autoSize={{ minRows: 1, maxRows: 4 }} disabled={readOnly} value={val} onChange={(e) => props.onChange(p, e.target.value)} />
        } else if (p.dataType === 'richText') {
          input = <RichEditor label={p.name} value={val} disabled={readOnly} onChange={(html) => props.onChange(p, html)} />
        } else if (p.dataType === 'image' || p.dataType === 'pdf') {
          input = <FileInput kind={p.dataType} label={p.name} value={val} disabled={readOnly} onChange={(d) => props.onChange(p, d)} />
        } else {
          input = <Input aria-label={p.name} className={struck ? 're-struck' : undefined} style={{ width: 120, ...strong }} disabled={readOnly} value={val} status={v?.critical ? 'error' : v?.abnormal ? 'warning' : undefined} onChange={(e) => props.onChange(p, e.target.value)} />
        }
        if (struck && p.dataType === 'options') input = <Input aria-label={p.name} className="re-struck" style={{ width: 170 }} disabled value={val} />
        return (
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            {input}
            {calc && !locked && (
              <Button
                variant="text"
                icon={<EditOutlined />}
                aria-label={`${v?.overridden ? 'Use calculated value for' : 'Override calculated value of'} ${p.name}`}
                aria-pressed={!!v?.overridden}
                onClick={() => props.onOverride(p, !v?.overridden)}
              />
            )}
          </span>
        )
      },
    },
    {
      title: 'Flag',
      width: 110,
      onCell: rest,
      render: (_, r) => {
        if (!r.p) return null
        const qualitative = ['options', 'text'].includes(r.p.dataType)
        return (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <FlagMark v={values[r.p.key]} />
            {qualitative && (
              <Checkbox
                aria-label={`Mark ${r.p.name} abnormal`}
                disabled={locked || rejected || !props.canEnter || !(values[r.p.key]?.value ?? '').trim()}
                checked={values[r.p.key]?.abnormal === 'abnormal'}
                onChange={(e) => props.onFlag(r.p!, e.target.checked)}
              >
                Abnormal
              </Checkbox>
            )}
          </span>
        )
      },
    },
    {
      title: 'Delta',
      width: 80,
      onCell: rest,
      render: (_, r) => {
        if (!r.p) return null
        const key = r.p.key
        const pv = prev?.values[key]
        const cur = values[key]?.value ?? ''
        const d = pv && deltaOn ? deltaCheck(cur, pv.value, tsToDate(prev.date), r.p, props.delta) : null
        const flagged = !!d?.flagged
        // The trend is offered for every parameter: today's value first, then earlier results of this patient.
        return (
          <Popover
            trigger="click"
            title={`Trend: ${r.p.name}`}
            content={
              <div>
                <div>Now: <b>{cur || '-'}</b> {r.p.unit} <span className="wl-muted">(range {rangeTextFor(r.p, values[key], ageDays, gender, condition) || '-'})</span></div>
                {!history.some((h) => h.values[key]) && <div className="wl-muted">No earlier results for this patient.</div>}
                {history.filter((h) => h.values[key]).map((h) => (
                  <div key={h.billNo + String(h.date?.seconds)}>
                    {tsToDate(h.date) ? fmtDateTime(h.date).slice(0, 11) : h.billNo}: <b>{h.values[key].value}</b> {r.p!.unit}
                    {cur && deltaPct(cur, h.values[key].value) !== null && <span className="wl-muted"> ({deltaPct(cur, h.values[key].value)}%)</span>}
                  </div>
                ))}
              </div>
            }
          >
            <Button variant="text" aria-label={`Previous values of ${r.p.name}${flagged ? ', large change' : ''}`} icon={<LineChartOutlined />}>
              {flagged ? <span className="re-delta"><WarningOutlined /> {d!.pct !== null ? `${d!.pct}%` : d!.abs}</span> : undefined}
            </Button>
          </Popover>
        )
      },
    },
    {
      title: 'Reference range',
      width: 180,
      onCell: rest,
      render: (_, r) => {
        if (!r.p) return null
        const edited = !!values[r.p.key]?.rangeOverride
        const canEdit = props.canEnter && !locked && !rejected && !['options', 'text', 'richText', 'image', 'pdf'].includes(r.p.dataType)
        return (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <span>{rangeTextFor(r.p, values[r.p.key], ageDays, gender, condition)}</span>
            {edited && <StatusChip variant="caution">Edited</StatusChip>}
            {canEdit && <Button variant="text" icon={<EditOutlined />} aria-label={`Edit reference range of ${r.p.name}`} onClick={() => props.onEditRange(r.p!)} />}
          </span>
        )
      },
    },
    { title: 'Unit', width: 80, onCell: rest, render: (_, r) => r.p?.unit },
    {
      title: prev ? `Previous (${tsToDate(prev.date) ? fmtDateTime(prev.date).slice(0, 11) : prev.billNo})` : 'Previous',
      width: 130,
      onCell: rest,
      render: (_, r) => {
        const pv = r.p ? prev?.values[r.p.key] : undefined
        return pv ? <span className="wl-muted">{pv.value}</span> : null
      },
    },
    {
      title: '',
      width: 48,
      onCell: rest,
      render: (_, r) =>
        r.p ? (
          <Popover
            trigger="click"
            title={`Comment: ${r.p.name}`}
            content={
              <div>
                <Input.TextArea aria-label={`Comment for ${r.p.name}`} rows={3} style={{ width: 260 }} disabled={locked} value={props.paramComments[r.p.key] ?? ''} onChange={(e) => props.onParamComment(r.p!.key, e.target.value)} />
                <Checkbox style={{ marginTop: 8 }} disabled={locked} checked={!result?.paramCommentHidden?.[r.p.key]} onChange={(e) => props.onParamCommentOnReport(r.p!.key, e.target.checked)}>
                  Show on report
                </Checkbox>
              </div>
            }
          >
            <Button variant="text" aria-label={`Comment on ${r.p.name}`} icon={<CommentOutlined style={props.paramComments[r.p.key] ? { color: 'var(--c-primary)' } : undefined} />} />
          </Popover>
        ) : null,
    },
  ]

  return (
    <Card className={`re-test ${props.dirty ? 're-test--dirty' : ''}`} as="section" aria-label={test.name}>
      <div className="re-test__head">
        <div className="re-test__title">
          <span>{test.name}</span>
          {(() => {
            // Re Run shows until the test is approved again (the value was cleared by the re-run).
            const key = result?.rerun && status !== 'approved' && status !== 'rejected' ? 'rerun' : status === 'approved' && result?.releaseType === 'provisional' ? 'provisional' : status
            return <StatusChip variant={ITEM_VARIANT[key] ?? 'neutral'}>{ITEM_LABEL[key] ?? status}</StatusChip>
          })()}
          {result?.autoVerified && <StatusChip variant="success" icon={<ThunderboltOutlined />}>Auto verified</StatusChip>}
          {props.dirty && <StatusChip variant="caution">Unsaved</StatusChip>}
        </div>
        <div className="re-test__bar">
          {runs.length > 0 && !locked && (
            <Button icon={<ExperimentOutlined />} onClick={props.onMachine}>Machine value</Button>
          )}
          <Button icon={<HistoryOutlined />} onClick={props.onVersions}>Versions</Button>
          {props.canEnter && !rejected && (!locked || props.canUnapprove) && (
            <Button icon={<ReloadOutlined />} onClick={props.onRerun} disabled={!result || !!props.rerunBlocked} title={props.rerunBlocked ?? undefined}>Re-run{result?.rerunCount ? ` (${result.rerunCount})` : ''}</Button>
          )}
        </div>
      </div>

      {props.qc && (props.qc.state === 'fail' || props.qc.state === 'none') && (
        <div className="re-notice re-notice--warn" role="status">
          {props.qc.state === 'fail' ? `QC failed today on ${props.qc.machineName}.` : `No QC run today on ${props.qc.machineName}.`}{' '}
          {props.qcReason ? 'Approval is blocked until a passing QC run is recorded.' : 'Results may not be reliable until QC passes.'}
        </div>
      )}
      {(result?.issues ?? []).map((i, n) => (
        <div key={n} className="re-notice re-notice--warn" role="status">
          <AlertOutlined /> Sample issue: {ISSUE_LABEL[i.type]}{i.note ? `. ${i.note}` : ''} <span className="wl-muted">({i.byName}, {fmtDateTime(new Date(i.at))})</span>
        </div>
      ))}
      {rejected && result?.rejected && (
        <div className="re-notice re-notice--crit" role="status">Rejected by {result.rejected.byName}: {result.rejected.reason}</div>
      )}
      {result?.sentBack && result.status !== 'approved' && (
        <div className="re-notice re-notice--warn" role="status">
          Sent back by {result.sentBack.byName}: {result.sentBack.reason}
        </div>
      )}
      {result?.status === 'hold' && (
        <div className="re-notice re-notice--warn" role="status">
          On hold{result.holdReason ? `: ${result.holdReason}` : ''}
          {result.heldAt ? <> since {fmtDateTime(new Date(result.heldAt))} ({fmtDur(Date.now() - result.heldAt)})</> : null}
        </div>
      )}
      {result?.status !== 'hold' && heldMs > 0 && <div className="wl-muted" style={{ marginBottom: 'var(--s-2)' }}>Time spent on hold: {fmtDur(heldMs)}</div>}
      {props.rerunBlocked && <div className="re-notice re-notice--warn" role="status">{props.rerunBlocked}</div>}
      {result?.autoVerifyCheck && !result.autoVerifyCheck.passed && result.status !== 'approved' && (
        <div className="re-notice re-notice--info" role="status">Not auto-verified: {result.autoVerifyCheck.reasons.join('; ') || 'needs a person'}.</div>
      )}
      {result?.autoVerified && (
        <div className="re-notice re-notice--ok" role="status">Approved by the auto-verification rules (version {result.autoVerifyRuleVersion ?? 1}) at {fmtDateTime(new Date(result.approvedAt && typeof (result.approvedAt as Timestamp).toMillis === 'function' ? (result.approvedAt as Timestamp).toMillis() : Date.now()))}.</div>
      )}
      {criticals.length > 0 && (
        <div className="re-notice re-notice--crit" role="alert">
          <b>Critical value:</b> {criticals.map((p) => `${p.name} ${values[p.key].value} ${p.unit}`).join('; ')}. Inform the clinician before releasing this report.
          {(result?.criticalAlerts ?? []).map((a, i) => (
            <div key={i}>
              Notified {a.notifiedTo || 'clinician'}{a.mode ? ` by ${CHANNEL[a.mode] ?? a.mode}` : ''}{a.readBack ? ', read back confirmed' : ''}: logged by {a.byName} on {fmtDateTime(new Date(a.at))}{a.note ? `. ${a.note}` : ''}
            </div>
          ))}
          {!(result?.criticalAlerts ?? []).length && result?.criticalAck && (
            <div>Acknowledged by {result.criticalAck.byName} on {fmtDateTime(new Date(result.criticalAck.at))}{result.criticalAck.note ? `: ${result.criticalAck.note}` : ''}</div>
          )}
          {!result?.criticalAck && result && !locked && (
            <div style={{ marginTop: 'var(--s-2)' }}><Button icon={<CheckOutlined />} onClick={props.onAck}>Record critical value notification</Button></div>
          )}
        </div>
      )}
      {locked && (
        <div className="re-notice re-notice--ok" role="status">
          Approved by {result?.approvedByName}{result?.releaseType === 'provisional' ? ' (Provisional)' : ''}.
          {props.canUnapprove ? ' Use Amend to correct values with a reason; every change is kept in Versions.' : ''}
        </div>
      )}
      {props.amending && (
        <div className="re-notice re-notice--warn" role="status">
          Amending an approved result. Save to record the amendment, or cancel to keep the approved values.
        </div>
      )}

      <Table<Row>
        size="small"
        rowKey="key"
        pagination={false}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        rowClassName={(r) => {
          if (r.header || !props.colourRows) return ''
          const v = values[r.p!.key]
          return v?.critical ? 're-rowtint--crit' : v?.abnormal ? 're-rowtint--abn' : ''
        }}
      />
      {dlc && (
        <div className={dlcOff(dlc) ? 're-notice re-notice--warn' : 'wl-muted'} role="status" style={{ marginTop: 'var(--s-2)' }}>
          Differential total: <b>{dlc.total}%</b> of {dlc.count} counted parameters{dlcOff(dlc) ? ' (should add up to 100%)' : ''}
        </div>
      )}
      {props.abnormalOnly && rows.length === 0 && <p className="wl-muted">No abnormal values in this test.</p>}
      {props.comment && (
        <>
          <Input.TextArea
            style={{ marginTop: 'var(--s-3)' }}
            aria-label={`Comment for ${test.name}`}
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={locked}
            value={props.comment}
            onChange={(e) => props.onComment(e.target.value)}
          />
          <Checkbox disabled={locked} checked={result?.commentOnReport !== false} onChange={(e) => props.onCommentOnReport(e.target.checked)}>
            Show comment on report
          </Checkbox>
        </>
      )}

      <div className="re-test__foot">
        <Checkbox checked={interpretationOn} onChange={(e) => props.onToggleInterpretation(e.target.checked)} disabled={locked}>
          Show interpretation
        </Checkbox>
        {!locked && !rejected && props.canEnter && (
          <>
            <Button icon={<MessageOutlined />} onClick={props.onAddComment}>Add comment</Button>
            <Button icon={<AlertOutlined />} onClick={props.onIssue}>Add issue</Button>
            <Button icon={<StopOutlined />} disabled={status === 'approved'} onClick={props.onReject}>Reject{props.selectedParams.length ? ` (${props.selectedParams.length} selected)` : ''}</Button>
            <Button icon={<PauseCircleOutlined />} disabled={status === 'approved'} onClick={props.onHold}>{status === 'hold' ? 'Release hold' : 'On hold'}</Button>
          </>
        )}
        {rejected && props.canEnter && <Button icon={<UndoOutlined />} onClick={props.onRestore}>Restore test</Button>}
        {props.onInterpret && (
          <Button icon={<RobotOutlined />} disabled={props.dirty || !hasAnyValue(result?.values ?? {}) || props.interpreting} onClick={props.onInterpret}>
            {props.interpreting ? 'Generating' : 'AI interpretation'}
          </Button>
        )}
        <span className="wl-toolbar__spacer" style={{ flex: 1 }} />
        {props.canApprove && !rejected && (
          <>
            {/* The release type can only be changed on an approved test (it opens the change-status dialog). */}
            <Select
              aria-label={`Release type for ${test.name}`}
              style={{ width: 120 }}
              disabled={status !== 'approved' || props.amending}
              value={status === 'approved' ? result?.releaseType ?? 'final' : 'final'}
              onChange={props.onReleaseChange}
              options={[{ value: 'final', label: 'Final' }, { value: 'provisional', label: 'Provisional' }]}
            />
            {(status !== 'approved' || (result?.releaseType === 'provisional' && !props.amending)) && (
              <Button variant="primary" icon={<CheckOutlined />} disabled={!!props.qcReason} onClick={status !== 'approved' ? props.onApprove : () => props.onReleaseChange('final')}>Approve</Button>
            )}
          </>
        )}
        {status === 'entered' && props.canApprove && (
          <Button icon={<RollbackOutlined />} onClick={props.onSendBack}>Send back</Button>
        )}
        {props.canUnapprove && locked && (
          <>
            <Button icon={<EditOutlined />} onClick={props.onAmend}>Amend</Button>
            <Button icon={<UndoOutlined />} onClick={props.onUnapprove}>Un-approve</Button>
          </>
        )}
        {props.amending && <Button onClick={props.onCancelAmend}>Cancel amend</Button>}
      </div>
    </Card>
  )
}
