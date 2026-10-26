import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../../firebase'

const call = <I, O>(name: string) => httpsCallable<I, O>(functions, name)

// Ask an outside consultant for a second opinion by email (private link, valid 7 days).
export const requestExternalOpinion = (input: { orderId: string; testId: string; name: string; email: string; note: string }) =>
  call<typeof input & { labId: string }, { status: string; to: string }>('requestExternalOpinion')({ ...input, labId: LAB_ID }).then((r) => r.data)

export const getExternalOpinion = (token: string) =>
  call<{ token: string }, {
    lab: { name: string }
    study: { name: string; modality: string; bodyPart: string }
    patient: { initials: string; age: string; gender: string }
    technique: string; findings: string; impression: string
    images: { caption: string; dataUrl: string }[]
    note: string; consultant: string
  }>('getExternalOpinion')({ token }).then((r) => r.data)

export const submitExternalOpinion = (input: { token: string; name: string; regNo: string; opinion: string; cosign: boolean }) =>
  call<typeof input, { ok: boolean }>('submitExternalOpinion')(input).then((r) => r.data)
