import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../firebase'

// Support chatbot: answers only from the server's help topics. Falls back to keyword search
// (mode 'search') when AI is off or unavailable.
export interface SupportTopicRef {
  id: string
  title: string
  screen: string
}
export interface SupportAnswer {
  mode: 'ai' | 'search'
  found: boolean
  answer: string
  topics: SupportTopicRef[]
  reason: string
}

export const supportChat = async (message: string, history: { role: 'user' | 'assistant'; text: string }[] = []): Promise<SupportAnswer> =>
  (await httpsCallable<object, SupportAnswer>(functions, 'supportChat', { timeout: 90_000 })({ labId: LAB_ID, message, history })).data
