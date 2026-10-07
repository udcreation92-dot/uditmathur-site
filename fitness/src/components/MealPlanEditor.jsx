import { useEffect, useState } from 'react'
import { MEALS } from '../lib/constants'
import { addDays, dow, DOW, DOW_LONG, fmtDay, monthOf, parse, today, weekDays } from '../lib/dates'

const blank = () => ({ 1: '', 2: '', 3: '', 4: '' })

export default function MealPlanEditor({ data }) {
  const [anchor, setAnchor] = useState(today())
  const week = weekDays(anchor)
  const { plans, ensureMonth, savePlans, fetchPlans } = data
  const [draft, setDraft] = useState({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [sel, setSel] = useState(dow(today())) // day shown on phones (0 = Mon)

  useEffect(() => { ensureMonth(monthOf(week[0])); ensureMonth(monthOf(week[6])) }, [week[0], ensureMonth]) // eslint-disable-line react-hooks/exhaustive-deps

  // (Re)load the draft from saved plans whenever the week changes, or plans arrive and nothing is being edited
  useEffect(() => {
    if (dirty) return
    setDraft(Object.fromEntries(week.map((d) => [d, { ...blank(), ...(plans[d] || {}) }])))
  }, [week[0], plans]) // eslint-disable-line react-hooks/exhaustive-deps

  const goWeek = (n) => {
    if (dirty && !confirm('You have unsaved changes to this week. Discard them?')) return
    setDirty(false); setMsg(''); setSel(0); setAnchor(addDays(week[0], n * 7))
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
  const copyDayToAll = () => {
    const src = draft[week[sel]] || blank()
    if (!confirm(`Copy ${DOW_LONG[sel]}'s meals to every day this week?`)) return
    setDraft(Object.fromEntries(week.map((d) => [d, { ...src }])))
    setDirty(true)
  }
  const save = async () => {
    setBusy(true)
    try { await savePlans(draft); setDirty(false); setMsg('Week saved ✓') } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="card p-1.5">
        <div className="flex items-center gap-1">
          <button aria-label="Previous week" className="btn-ghost border-0 w-11 px-0 text-lg" onClick={() => goWeek(-1)}>‹</button>
          <div className="flex-1 text-center leading-tight">
            <div className="font-head text-lg font-semibold uppercase">Week of {fmtDay(week[0])}</div>
            <div className="text-xs text-neutral-500">to {fmtDay(week[6])}</div>
          </div>
          <button aria-label="Next week" className="btn-ghost border-0 w-11 px-0 text-lg" onClick={() => goWeek(1)}>›</button>
        </div>
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 p-1.5 pt-2">
          <button className="btn-ghost" disabled={busy} onClick={copyPrevWeek}>⧉ Copy last week</button>
          <button className="btn-ghost" disabled={busy} onClick={copyDayToAll}>{DOW[sel]} → all days</button>
          <div className="hidden sm:block flex-1" />
          <button className="hidden sm:inline-flex btn-primary" disabled={busy || !dirty} onClick={save}>{dirty ? 'Save week' : 'Saved'}</button>
        </div>
        {msg && <p className="px-2 pb-1 text-sm text-neutral-600">{msg}</p>}
      </div>

      {/* day picker (phones) */}
      <div className="grid grid-cols-7 gap-1 md:hidden">
        {week.map((d, i) => {
          const planned = Object.values(draft[d] || {}).some((v) => v?.trim())
          return (
            <button key={d} onClick={() => setSel(i)}
              className={`rounded-xl py-1.5 text-center border ${i === sel ? 'bg-ink text-white border-ink' : d === today() ? 'bg-red-50 border-red-200' : 'bg-white border-neutral-200'}`}>
              <div className="text-[0.62rem] uppercase opacity-70">{DOW[i]}</div>
              <div className="text-base font-bold leading-tight">{parse(d).getDate()}</div>
              <div className={`mx-auto mt-0.5 w-1.5 h-1.5 rounded-full ${planned ? 'bg-emerald-500' : 'bg-transparent'}`} />
            </button>
          )
        })}
      </div>

      <p className="hidden md:block text-xs text-neutral-500 px-1">
        Plans are per date, so a mid-week change only affects the days you edit. You can also edit a single day's planned meal directly in the client's Day view.
      </p>

      {week.map((d, i) => (
        <section key={d} className={`card ${i === sel ? '' : 'hidden md:block'} ${d === today() ? 'md:ring-2 md:ring-brand' : ''}`}>
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
        <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] md:bottom-3 z-20 flex justify-end">
          <button className="btn-primary shadow-lg w-full md:w-auto h-12 text-base" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save week'}</button>
        </div>
      )}
    </div>
  )
}
