import { useEffect, useState } from 'react'
import { Form, Input, Modal } from 'antd'
import type { ApprovalRecord } from '../types'

// Approval sign-off (approver, designation, remarks) used by ILC and equipment validation.
export function ApproveModal({ open, title, defaultName, onOk, onCancel }: { open: boolean; title: string; defaultName: string; onOk: (r: Omit<ApprovalRecord, 'by' | 'at'>) => void; onCancel: () => void }) {
  const [form] = Form.useForm<Omit<ApprovalRecord, 'by' | 'at'>>()
  useEffect(() => {
    if (open) form.setFieldsValue({ approverName: defaultName, designation: '', remarks: '' })
  }, [open, defaultName, form])
  return (
    <Modal title={title} open={open} okText="Approve" onCancel={onCancel} onOk={async () => onOk(await form.validateFields())} destroyOnHidden>
      <Form form={form} layout="vertical">
        <Form.Item name="approverName" label="Approver" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="designation" label="Designation" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="remarks" label="Remarks"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </Modal>
  )
}

// Soft delete: a reason is required and the record stays on file.
export function DeleteReasonModal({ open, title, onOk, onCancel }: { open: boolean; title: string; onOk: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  return (
    <Modal title={title} open={open} okText="Delete" okButtonProps={{ danger: true, disabled: !reason.trim() }} onCancel={onCancel} onOk={() => onOk(reason.trim())} destroyOnHidden>
      <Input.TextArea rows={3} aria-label="Reason for deleting" placeholder="Reason (required). The record is kept for audit." value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  )
}
