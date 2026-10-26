import { can, useAuth } from '../../../auth/AuthProvider'

// Inventory capabilities come from the permissions matrix.
export function useActor() {
  const { profile } = useAuth()
  const role = profile?.role
  return {
    name: profile?.name ?? 'unknown',
    canManage: can(profile, 'inventory.manage'),
    canAdjust: can(profile, 'inventory.adjust'),
    canReceive: can(profile, 'inventory.receive'),
    canItems: can(profile, 'inventory.items'),
    canSuppliers: can(profile, 'inventory.suppliers'),
    canPurchase: can(profile, 'inventory.purchase'),
    canConsume: can(profile, 'inventory.consume'),
    canMapping: can(profile, 'inventory.mapping'),
    canDelete: role === 'labAdmin' || role === 'admin',
  }
}
