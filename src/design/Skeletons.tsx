import type { CSSProperties } from 'react'

// First-load skeletons (tonal shimmer 1.2s). aria-hidden: pair with a
// visually-hidden "Loading" status where it matters.
export function Skeleton({ width = '100%', height = 14, radius = 8, style }: {
  width?: number | string
  height?: number | string
  radius?: number | string
  style?: CSSProperties
}) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />
}

export function SkeletonRows({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="skeleton-rows" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div className="skeleton-row" key={r} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} width={c === 0 ? '70%' : '55%'} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card skeleton-card" role="status" aria-label="Loading">
      <Skeleton width="40%" height={18} />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={`${90 - i * 15}%`} />
      ))}
    </div>
  )
}
