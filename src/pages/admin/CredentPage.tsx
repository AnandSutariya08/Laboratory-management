import { useEffect } from 'react'
import { App, Form, Input, InputNumber } from 'antd'
import { setDoc } from 'firebase/firestore'
import { labDoc } from '../../lib/db'
import { useLiveDoc } from '../../hooks/useLive'
import { Button } from '../../design/Button'
import { Card } from '../../design/Card'
import { PageHeader } from '../../design/PageHeader'
import { StatusChip } from '../../design/StatusChip'

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
          <Form.Item name="company" label="Company name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="labName" label="Lab name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="pincode" label="Pincode" rules={[{ required: true, pattern: /^\d{6}$/, message: '6 digits' }]}><Input maxLength={6} inputMode="numeric" /></Form.Item>
          <Form.Item name="landmark" label="Landmark"><Input /></Form.Item>
          <Form.Item name="address" label="Address" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="city" label="City" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="Sample drop location (latitude, longitude)">
            <Input.Group compact>
              <Form.Item name="lat" noStyle><InputNumber placeholder="Latitude" min={-90} max={90} style={{ width: 160 }} aria-label="Latitude" /></Form.Item>
              <Form.Item name="lng" noStyle><InputNumber placeholder="Longitude" min={-180} max={180} style={{ width: 160 }} aria-label="Longitude" /></Form.Item>
            </Input.Group>
          </Form.Item>
          <Button variant="primary" onClick={() => void save()}>Save details</Button>
        </Form>
      </Card>
    </div>
  )
}
