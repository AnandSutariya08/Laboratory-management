import { useEffect } from 'react'
import { App, Form, Input, InputNumber } from 'antd'
import { setDoc } from 'firebase/firestore'
import { labDoc } from '../../lib/db'
import { useLiveDoc } from '../../hooks/useLive'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { PageHeader } from '../../design/PageHeader'
import { StatusChip } from '../../design/StatusChip'
import { FieldGrid, FormSection } from '../../design/FormLayout'

// Home-collection partner onboarding ("Credent" in the Flabs menu): the lab's pickup details are saved
// here; the partner API itself is an external service and is not connected, so the status stays
// "Not onboarded" until a provider integration is configured and stamps `credent.onboardedAt`.
interface CredentForm { company: string; labName: string; pincode: string; landmark: string; address: string; city: string; lat: number | null; lng: number | null }

export default function CredentPage() {
  const { message } = App.useApp()
  const [form] = Form.useForm<CredentForm>()
  const { data } = useLiveDoc<{ credent?: Partial<CredentForm> & { onboardedAt?: unknown } }>(labDoc(), [])
  useEffect(() => { if (data?.credent) form.setFieldsValue(data.credent) }, [data?.credent]) // eslint-disable-line react-hooks/exhaustive-deps
  const onboarded = !!data?.credent?.onboardedAt
  const save = async () => {
    const v = await form.validateFields()
    try {
      await setDoc(labDoc(), { credent: { ...v } }, { merge: true })
      message.success('Saved. Onboarding with the partner is not connected yet.')
    } catch {
      message.error('Only a lab admin can save these details.')
    }
  }
  return (
    <div>
      <PageHeader title="Credent" subtitle="Home-collection partner onboarding." actions={<StatusChip variant={onboarded ? 'success' : 'neutral'}>{onboarded ? 'Onboarded' : 'Not onboarded'}</StatusChip>} />
      <Card>
        <Form form={form} layout="vertical" style={{ maxWidth: 960 }}>
          <FormSection title="Business" description="Who we register with the partner.">
            <FieldGrid min={260}>
              <Form.Item name="company" label="Company name" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name="labName" label="Lab name" rules={[{ required: true }]}><Input /></Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Pickup address" description="Where the partner collects or delivers.">
            <Form.Item name="address" label="Address" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item>
            <FieldGrid min={200}>
              <Form.Item name="city" label="City" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name="pincode" label="Pincode" rules={[{ required: true, pattern: /^\d{6}$/, message: '6 digits' }]}><Input maxLength={6} inputMode="numeric" /></Form.Item>
              <Form.Item name="landmark" label="Landmark"><Input /></Form.Item>
            </FieldGrid>
          </FormSection>
          <FormSection title="Sample drop location" description="Map coordinates of the lab, in decimal degrees.">
            <FieldGrid min={200}>
              <Form.Item name="lat" label="Latitude"><InputNumber placeholder="e.g. 19.0760" min={-90} max={90} style={{ width: '100%' }} /></Form.Item>
              <Form.Item name="lng" label="Longitude"><InputNumber placeholder="e.g. 72.8777" min={-180} max={180} style={{ width: '100%' }} /></Form.Item>
            </FieldGrid>
          </FormSection>
          <div style={{ marginTop: 'var(--s-5)' }}><Button variant="primary" onClick={() => void save()}>Save details</Button></div>
        </Form>
      </Card>
    </div>
  )
}
