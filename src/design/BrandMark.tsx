// The Healthcare Labs mark: blue tile on a darker offset tile, crossed by a white pulse line.
// Same drawing as public/favicon.svg. Decorative by default; pass `title` when it stands alone.
export function BrandMark({ size = 36, title, className = '' }: { size?: number; title?: string; className?: string }) {
  return (
    <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 64 64" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect x="9" y="9" width="52" height="52" rx="12" fill="#14609F" />
      <rect x="3" y="3" width="52" height="52" rx="12" fill="#1E97D8" />
      <path d="M1 37H15L23 15L33 49L41 31H63" fill="none" stroke="#14609F" strokeWidth="8.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1 37H15L23 15L33 49L41 31H63" fill="none" stroke="#FFFFFF" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
