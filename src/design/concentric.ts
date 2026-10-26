// Concentric corners (DESIGN.md §2.7): inner radius = outer radius - padding,
// never below the minimum so nested corners stay visibly rounded.
export function concentric(outer: number, padding: number, min = 8): number {
  return Math.max(outer - padding, min)
}
