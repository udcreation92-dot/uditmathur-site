import { useEffect, useState } from 'react'
import { MEALS } from '../lib/constants'
import { addDays, DOW_LONG, fmtDay, monthOf, today, weekDays } from '../lib/dates'

const blank = () => ({ 1: '', 2: '', 3: '', 4: '' })

export default function MealPlanEditor({ data }) {
  const [anchor, setAnchor] = useState(today())
  const week = weekDays(anchor)
  const { plans, ensureMonth, savePlans, fetchPlans } = data
  const [draft, setDraft] = useState({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { ensureMonth(monthOf(week[0])); ensureMonth(monthOf(week[6])) }, [week[0], ensureMonth]) // eslint-disable-line react-hooks/exhaustive-deps

  // (Re)load the draft from saved plans whenever the week changes, or plans arrive and nothing is being edited
  useEffect(() => {
    if (dirty) return
    setDraft(Object.fromEntries(week.map((d) => [d, { ...blank(), ...(plans[d] || {}) }])))
  }, [week[0], plans]) // eslint-disable-line react-hooks/exhaustive-deps

  const goWeek = (n) => {
    if (dirty && !confirm('You have unsaved changes to this week. Discard them?')) return
    setDirty(false); setMsg(''); setAnchor(addDays(week[0], n * 7))
  }
  const edit = (d, no, v) => { setDraft((p) => ({ ...p, [d]: { ...p[d], [no]: v } })); setDirty(true); setMsg('') }

  const copyPrevWeek = async () => {
    setBusy(true)
    try {
      const prev = await fetchPlans(addDays(week[0], -7), addDays(week[0], -1))
      setDraft(Object.fromEntries(week.map((d) => [d, { ...blank(), ...(prev[addDays(d, -7)] || {}) }])))
      setDirty(true); setMsg('Copied last week — review and Save.')
    } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }
  const copyMondayToAll = () => {
    const mon = draft[week[0]] || blank()
    setDraft(Object.fromEntries(week.map((d) => [d, { ...mon }])))
    setDirty(true)
  }
  const save = async () => {
    setBusy(true)
    try { await savePlans(draft); setDirty(false); setMsg('Week saved ✓') } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="flex items-center gap-2">
          <button className="btn-ghost px-3" onClick={() => goWeek(-1)}>◀</button>
          <div className="flex-1 text-center">
            <div className="font-head text-lg font-semibold uppercase">Week of {fmtDay(week[0])}</div>
            <div className="text-xs text-neutral-500">to {fmtDay(week[6])}</div>
          </div>
          <button className="btn-ghost px-3" onClick={() => goWeek(1)}>▶</button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <button className="btn-ghost" disabled={busy} onClick={copyPrevWeek}>⧉ Copy previous week</button>
          <button className="btn-ghost" disabled={busy} onClick={copyMondayToAll}>Monday → all days</button>
          <div className="flex-1" />
          {msg && <span className="self-center text-sm text-neutral-600">{msg}</span>}
          <button className="btn-primary" disabled={busy || !dirty} onClick={save}>{dirty ? 'Save week' : 'Saved'}</button>
        </div>
      </div>

      <p className="text-xs text-neutral-500 px-1">
        Plans are per date, so a mid-week change only affects the days you edit. You can also edit a single day's planned meal directly in the client's Day view.
      </p>

      {week.map((d, i) => (
        <section key={d} className={`card ${d === today() ? 'ring-2 ring-brand' : ''}`}>
          <div className="card-h">
            <h2 className="flex-1">{DOW_LONG[i]}</h2>
            <span className="text-xs text-neutral-400">{fmtDay(d)}</span>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4">
            {MEALS.map((m) => (
              <label key={m.no} className={`${m.bg} block p-3`}>
                <span className="lbl">{m.icon} {m.name} · {m.eg}</span>
                <textarea className="inp bg-white/80" rows={3} value={draft[d]?.[m.no] || ''} onChange={(e) => edit(d, m.no, e.target.value)} />
              </label>
            ))}
          </div>
        </section>
      ))}

      {dirty && (
        <div className="sticky bottom-3 flex justify-end">
          <button className="btn-primary shadow-lg" disabled={busy} onClick={save}>Save week</button>
        </div>
      )}
    </div>
  )
}
