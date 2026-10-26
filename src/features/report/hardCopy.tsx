import { useCallback } from 'react'
import { App, Input } from 'antd'
import { markDispatched } from '../../lib/orders'
import type { DispatchMode, Order } from '../../types'
import { useReportLayout } from './layout'

// Hard copy dispatch asks who received the report and, optionally, a courier tracking number (DP-04).
// Every place that marks a dispatch as delivered should go through this hook.
// Bulk variant: asks once who received the hard copies (when any bill has a pending hard copy) and applies it to all.
export function useMarkDispatchedMany() {
  const { modal, message } = App.useApp()
  const layout = useReportLayout()
  return useCallback(
    (orders: Order[], onlyMode?: DispatchMode): Promise<number> => {
      const run = async (extra?: { receiverName: string; trackingNo: string }) => {
        let n = 0
        for (const o of orders) {
          const modes = o.dispatch.filter((d) => !d.delivered && (!onlyMode || d.mode === onlyMode)).map((d) => d.mode)
          if (!modes.length) continue
          for (const m of modes) await markDispatched(o, m, m === 'hardcopy' ? extra : undefined)
          n++
        }
        return n
      }
      const hasHard = orders.some((o) => o.dispatch.some((d) => d.mode === 'hardcopy' && !d.delivered && (!onlyMode || onlyMode === 'hardcopy')))
      if (!hasHard || !layout.hardCopyPrompt) return run()
      const v = { receiverName: '', trackingNo: '' }
      return new Promise<number>((resolve) => {
        modal.confirm({
          title: 'Hard copy handover',
          okText: 'Mark delivered',
          content: (
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <label>Received by<Input aria-label="Receiver name" autoFocus placeholder="Name of the person who received them" onChange={(e) => (v.receiverName = e.target.value)} /></label>
              <label>Courier tracking number (optional)<Input aria-label="Tracking number" onChange={(e) => (v.trackingNo = e.target.value)} /></label>
            </div>
          ),
          onOk: async () => {
            if (!v.receiverName.trim()) {
              message.error('Enter the name of the person who received the hard copies')
              return Promise.reject(new Error('receiver'))
            }
            resolve(await run({ receiverName: v.receiverName.trim(), trackingNo: v.trackingNo.trim() }))
          },
          onCancel: () => resolve(0),
        })
      })
    },
    [layout.hardCopyPrompt, modal, message],
  )
}

export function useMarkDispatched() {
  const { modal, message } = App.useApp()
  const layout = useReportLayout()
  return useCallback(
    (order: Order, mode: DispatchMode): Promise<boolean> => {
      if (mode !== 'hardcopy' || !layout.hardCopyPrompt) return markDispatched(order, mode).then(() => true)
      const v = { receiverName: '', trackingNo: '' }
      return new Promise<boolean>((resolve) => {
        modal.confirm({
          title: 'Hard copy handover',
          okText: 'Mark delivered',
          content: (
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <label>Received by<Input aria-label="Receiver name" autoFocus placeholder="Name of the person who received it" onChange={(e) => (v.receiverName = e.target.value)} /></label>
              <label>Courier tracking number (optional)<Input aria-label="Tracking number" placeholder="e.g. courier docket number" onChange={(e) => (v.trackingNo = e.target.value)} /></label>
            </div>
          ),
          onOk: async () => {
            if (!v.receiverName.trim()) {
              message.error('Enter the name of the person who received the hard copy')
              return Promise.reject(new Error('receiver'))
            }
            await markDispatched(order, mode, { receiverName: v.receiverName.trim(), trackingNo: v.trackingNo.trim() })
            resolve(true)
          },
          onCancel: () => resolve(false),
        })
      })
    },
    [layout.hardCopyPrompt, modal, message],
  )
}
