import { useFeatureFlags } from '../features/settings/lib'
import type { NavFlags } from './nav'

// Per-lab module flags that hide sidebar entries (Lab Settings > Lab features).
export function useNavFlags(): NavFlags {
  return useFeatureFlags()
}
