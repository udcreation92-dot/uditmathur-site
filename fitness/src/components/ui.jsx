export function Card({ icon, title, right, children, className = '', id }) {
  return (
    <section id={id} className={`card scroll-mt-sticky ${className}`}>
      <div className="card-h">
        <span className="ico">{icon}</span>
        <h2 className="flex-1">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

// Big tappable checkbox
export function Check({ checked, onChange, label, className = '' }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2.5 min-h-[2.75rem] text-left text-sm font-medium ${className}`}
    >
      <span className={`grid place-items-center w-7 h-7 shrink-0 rounded-lg border-2 text-base font-bold
        ${checked ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-neutral-400'}`}>
        {checked ? '✓' : ''}
      </span>
      {label}
    </button>
  )
}

// Yes / No / unset
export function YesNo({ value, onChange, yes = 'Yes', no = 'No' }) {
  const b = (v, txt, on) => (
    <button
      type="button"
      onClick={() => onChange(value === v ? null : v)}
      className={`min-w-[4.25rem] h-11 sm:h-9 px-3 text-sm font-semibold rounded-xl border active:scale-[0.97] ${value === v ? on : 'bg-white border-neutral-300 text-neutral-600'}`}
    >{txt}</button>
  )
  return (
    <div className="flex gap-2">
      {b(true, yes, 'bg-emerald-500 border-emerald-500 text-white')}
      {b(false, no, 'bg-brand border-brand text-white')}
    </div>
  )
}

// 1–5 rating — stretches full width on phones
export function Rating({ value, onChange }) {
  return (
    <div className="flex gap-1.5 w-full sm:w-auto">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(value === n ? null : n)}
          className={`flex-1 sm:flex-none sm:w-9 h-11 sm:h-9 rounded-xl text-base sm:text-sm font-bold border active:scale-[0.97] ${value === n ? 'bg-ink text-white border-ink' : 'bg-white border-neutral-300 text-neutral-600'}`}
        >{n}</button>
      ))}
    </div>
  )
}

export function Field({ label, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="lbl">{label}</span>
      {children}
    </label>
  )
}

// stack: label above a full-width control on phones (used for 1–5 ratings)
export function Row({ label, hint, children, stack = false }) {
  return (
    <div className={`flex gap-2 px-4 py-3 border-t border-neutral-100 first:border-t-0
      ${stack ? 'flex-col sm:flex-row sm:items-center sm:justify-between' : 'items-center justify-between'}`}>
      <div className="text-sm font-semibold min-w-0">
        {label}
        {hint && <span className="ml-1.5 text-xs font-normal text-neutral-500">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export function SaveBadge({ status, error, onRetry }) {
  if (status === 'saving') return <span className="text-xs text-neutral-400">Saving…</span>
  if (status === 'saved') return <span className="text-xs text-emerald-400">✓ Saved</span>
  if (status === 'loading') return <span className="text-xs text-neutral-400">Loading…</span>
  if (status === 'error') {
    return (
      <button onClick={onRetry} className="text-xs text-red-300 underline" title={error}>
        Not saved — retry
      </button>
    )
  }
  return null
}
