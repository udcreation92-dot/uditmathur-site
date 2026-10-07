export function Card({ icon, title, right, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
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
      className={`flex items-center gap-2 text-left text-sm font-medium ${className}`}
    >
      <span className={`grid place-items-center w-6 h-6 shrink-0 rounded-md border-2 text-sm font-bold
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
      className={`px-3 py-1.5 text-sm font-semibold rounded-lg border ${value === v ? on : 'bg-white border-neutral-300 text-neutral-600'}`}
    >{txt}</button>
  )
  return (
    <div className="flex gap-2">
      {b(true, yes, 'bg-emerald-500 border-emerald-500 text-white')}
      {b(false, no, 'bg-brand border-brand text-white')}
    </div>
  )
}

// 1–5 rating
export function Rating({ value, onChange }) {
  return (
    <div className="flex gap-1.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(value === n ? null : n)}
          className={`w-9 h-9 rounded-lg text-sm font-bold border ${value === n ? 'bg-ink text-white border-ink' : 'bg-white border-neutral-300 text-neutral-600'}`}
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

export function Row({ label, hint, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-neutral-100 first:border-t-0">
      <div className="text-sm font-semibold">
        {label}
        {hint && <div className="text-xs font-normal text-neutral-500">{hint}</div>}
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
