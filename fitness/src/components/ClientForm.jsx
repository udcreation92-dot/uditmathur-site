import { useState } from 'react'
import { Field } from './ui'

// Profile fields shared by "Add client" and the trainer's Profile tab.
export default function ClientForm({ initial = {}, submitLabel, onSubmit, onCancel }) {
  const [f, setF] = useState({
    name: initial.name || '', goal: initial.goal || '',
    start_date: initial.start_date || '', target_date: initial.target_date || '',
    steps_target: initial.steps_target ?? '', water_target: initial.water_target ?? 3,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try { await onSubmit({ ...initial, ...f }) } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} className="p-4 grid sm:grid-cols-2 gap-3">
      <Field label="Client name"><input className="inp" required value={f.name} onChange={set('name')} /></Field>
      <Field label="Goal"><input className="inp" placeholder="e.g. Lose 6 kg fat" value={f.goal} onChange={set('goal')} /></Field>
      <Field label="Start date"><input className="inp" type="date" value={f.start_date} onChange={set('start_date')} /></Field>
      <Field label="Target date"><input className="inp" type="date" value={f.target_date} onChange={set('target_date')} /></Field>
      <Field label="Daily steps target"><input className="inp" type="number" min="0" step="500" placeholder="e.g. 8000" value={f.steps_target} onChange={set('steps_target')} /></Field>
      <Field label="Daily water target (L)"><input className="inp" type="number" min="0" step="0.5" value={f.water_target} onChange={set('water_target')} /></Field>
      {err && <p className="sm:col-span-2 text-sm text-brand">{err}</p>}
      <div className="sm:col-span-2 flex gap-2 justify-end">
        {onCancel && <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  )
}
