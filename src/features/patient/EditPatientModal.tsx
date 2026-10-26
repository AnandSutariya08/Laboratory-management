import { useEffect, useState } from 'react'
import { App, Form, Input, InputNumber, Modal, Select, Switch } from 'antd'
import { doc, updateDoc, writeBatch } from 'firebase/firestore'
import { useAuth } from '../../auth/AuthProvider'
import { db, LAB_ID } from '../../firebase'
import { docRef, paths } from '../../lib/db'
import { patientEditLockReason, uhidTaken } from '../../lib/orders'
import { DISPATCH_OPTIONS } from '../../components/billing/helpers'
import { fetchPatientOrders, logActivity, useMaster } from './lib'
import type { PatientDoc } from './types'
import { dialogWidth } from '../../design/dialog'

export default function EditPatientModal({ patient, open, onClose }: { patient: PatientDoc; open: boolean; onClose: () => void }) {
  const { message } = App.useApp()
  const { profile } = useAuth()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [propagate, setPropagate] = useState(true)
  const referrers = useMaster('referrers')
  const hospitals = useMaster('hospitals')
  useEffect(() => {
    if (open) form.setFieldsValue({ ...patient, referrerHospital: patient.referrerHospital ?? '' })
  }, [open, patient, form])

  const doctorOpts = referrers.filter((r) => r.type !== 'hospital').map((r) => ({ value: r.name }))
  const hospOpts = [...hospitals, ...referrers.filter((r) => r.type === 'hospital')].map((r) => ({ value: r.name }))

  const save = async () => {
    const v = await form.validateFields()
    if (!profile) return
    setSaving(true)
    try {
      const frozen = await patientEditLockReason(patient.id)
      if (frozen) {
        message.error(frozen)
        setSaving(false)
        return
      }
      const newUhid = (v.uhid ?? '').trim()
      if (newUhid && newUhid !== (patient.uhid ?? '') && (await uhidTaken(newUhid, patient.id))) {
        message.error(`UHID ${newUhid} is already used by another patient.`)
        setSaving(false)
        return
      }
      const docr = referrers.find((r) => r.name === v.referrerName && r.type !== 'hospital')
      const hosp = [...hospitals, ...referrers.filter((r) => r.type === 'hospital')].find((r) => r.name === v.referrerHospital)
      const patch = {
        referrerId: docr?.id ?? '',
        hospitalId: hosp?.id ?? '',
        firstName: v.firstName.trim(),
        lastName: (v.lastName ?? '').trim(),
        gender: v.gender,
        ageValue: v.ageValue,
        ageUnit: v.ageUnit,
        phone: v.phone ?? '',
        email: v.email ?? '',
        dispatchModes: v.dispatchModes ?? [],
        referrerName: v.referrerName || 'Self',
        referrerHospital: v.referrerHospital ?? '',
        uhid: (v.uhid ?? '').trim(),
        aadhaar: (v.aadhaar ?? '').trim(),
        abhaNumber: (v.abhaNumber ?? '').trim(),
        abhaAddress: (v.abhaAddress ?? '').trim(),
        insuranceNo: (v.insuranceNo ?? '').trim(),
        district: (v.district ?? '').trim(),
        town: (v.town ?? '').trim(),
        weight: v.weight ?? null,
        height: v.height ?? null,
        clinicalHistory: (v.clinicalHistory ?? '').trim(),
      }
      await updateDoc(docRef(paths.patients, patient.id), patch)
      if (propagate) {
        const name = `${patient.salutation} ${patch.firstName} ${patch.lastName}`.replace(/\s+/g, ' ').trim()
        const orders = await fetchPatientOrders(patient.id, profile)
        for (let i = 0; i < orders.length; i += 400) {
          const b = writeBatch(db)
          for (const o of orders.slice(i, i + 400))
            b.update(doc(db, 'labs', LAB_ID, 'orders', o.id), {
              patientName: name,
              gender: patch.gender,
              ageValue: patch.ageValue,
              ageUnit: patch.ageUnit,
              referrerName: patch.referrerName,
              uhid: patch.uhid,
              hospitalName: patch.referrerHospital,
            })
          await b.commit()
        }
      }
      await logActivity('patient.edit', `Edited patient ${patient.patientNo} ${patient.firstName}`, `patients/${patient.id}`, { category: 'OTHER', actor: profile })
      message.success('Patient updated')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title="Edit patient" okText="Save" onOk={save} confirmLoading={saving} destroyOnHidden width={dialogWidth(640)}>
      <Form form={form} layout="vertical">
        <div className="pl-grid2">
          <Form.Item label="Patient ID"><Input value={patient.patientNo} disabled /></Form.Item>
          <Form.Item name="uhid" label="UHID"><Input /></Form.Item>
          <Form.Item name="firstName" label="First name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="lastName" label="Last name"><Input /></Form.Item>
          <Form.Item name="ageValue" label="Age" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="ageUnit" label="Age type"><Select options={[{ value: 'year', label: 'Years' }, { value: 'month', label: 'Months' }, { value: 'day', label: 'Days' }]} /></Form.Item>
          <Form.Item name="gender" label="Gender"><Select options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} /></Form.Item>
          <Form.Item name="phone" label="Phone"><Input inputMode="tel" /></Form.Item>
          <Form.Item name="email" label="Email"><Input type="email" /></Form.Item>
          <Form.Item name="dispatchModes" label="Dispatch methods"><Select mode="multiple" options={DISPATCH_OPTIONS} /></Form.Item>
          <Form.Item name="referrerName" label="Referring doctor"><Select showSearch allowClear options={doctorOpts} placeholder="Self" /></Form.Item>
          <Form.Item name="referrerHospital" label="Referring hospital"><Select showSearch allowClear options={hospOpts} /></Form.Item>
          <Form.Item name="insuranceNo" label="Insurance no."><Input maxLength={40} /></Form.Item>
          <Form.Item name="district" label="District"><Input maxLength={80} /></Form.Item>
          <Form.Item name="town" label="Town"><Input maxLength={80} /></Form.Item>
          <Form.Item name="weight" label="Weight (kg)"><InputNumber min={0} max={500} precision={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="height" label="Height (cm)"><InputNumber min={0} max={300} precision={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="clinicalHistory" label="Clinical history"><Input.TextArea rows={2} maxLength={1000} /></Form.Item>
          <Form.Item name="aadhaar" label="Aadhaar"><Input maxLength={12} inputMode="numeric" /></Form.Item>
          <Form.Item name="abhaNumber" label="ABHA number"><Input /></Form.Item>
          <Form.Item name="abhaAddress" label="ABHA address"><Input /></Form.Item>
        </div>
        <label className="pl-toggle">
          <span>Also update name, age and referrer on existing bills</span>
          <Switch checked={propagate} onChange={setPropagate} aria-label="Update existing bills" />
        </label>
      </Form>
    </Modal>
  )
}
