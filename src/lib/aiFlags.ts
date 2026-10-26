import { httpsCallable } from 'firebase/functions'
import { functions, LAB_ID } from '../firebase'

// Advisory flag suggestions for result entry. The server never writes to results: the caller decides
// whether to apply a suggestion.
export type SuggestedFlag = 'low' | 'high' | 'critical' | 'abnormal' | 'normal' | 'review'
export interface FlagSuggestion {
  testId: string
  parameter: string
  parameterKey: string
  suggestedFlag: SuggestedFlag
  reason: string
}

export const suggestResultFlags = async (orderId: string, testIds?: string[]): Promise<FlagSuggestion[]> =>
  (await httpsCallable<object, { advisory: true; suggestions: FlagSuggestion[] }>(functions, 'suggestResultFlags', { timeout: 120_000 })({ labId: LAB_ID, orderId, testIds })).data.suggestions
