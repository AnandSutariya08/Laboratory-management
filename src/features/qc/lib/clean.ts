// Firestore rejects undefined field values; drop them before a write.
export const stripUndefined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
