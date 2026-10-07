import { useEffect, useRef, useState } from 'react'
import { MEALS, MACROS, TRAINING_TYPES, num } from '../lib/constants'
import { addMonths, fmtMonth, monthDays, monthOf, parse, sleepHours, today } from '../lib/dates'

const tick = (v) => (v === true ? { t: '✓', c: 'text-emerald-600 font-bold' } : v === false ? { t: '✗', c: 'text-brand font-bold' } : null)
const val = (v) => (num(v) == null ? null : { t: String(num(v)) })
const TT = Object.fromEntries(TRAINING_TYPES.map((t) => [t.k, t]))

// kind: 'bool' → summary = count of ✓ ; 'num' → summary = average
const GROUPS = (client) => [
  {
    title: 'Meals', bg: 'bg-m1', rows: MEALS.map((m) => ({
      label: `${m.icon} ${m.name}`, kind: 'bool',
      get: (d) => {
        const v = d.meals?.[m.no]
        const r = tick(v?.taken)
        return r && v?.taken === false && v.ate ? { ...r, title: `Ate: ${v.ate}` } : r
      },
      raw: (d) => d.meals?.[m.no]?.taken,
    })),
  },
  {
    title: 'Macros', bg: 'bg-m2', rows: [
      ...MACROS.map((m) => ({ label: `${m.icon} ${m.label}`, kind: 'num', get: (d) => val(d.macros?.[m.k]), raw: (d) => num(d.macros?.[m.k]) })),
      { label: '💊 Supplementation', kind: 'text', get: (d) => (d.macros?.supp ? { t: '•', title: d.macros.supp, c: 'text-violet-600 font-bold' } : null) },
    ],
  },
  {
    title: 'Habits', bg: 'bg-m3', rows: [
      { label: `👟 Steps${client?.steps_target ? ` (${client.steps_target})` : ''}`, kind: 'num',
        get: (d) => { const s = num(d.habits?.steps); if (s == null) return null; const hit = client?.steps_target && s >= client.steps_target; return { t: s >= 1000 ? `${Math.round(s / 100) / 10}k` : String(s), c: hit ? 'text-emerald-600 font-semibold' : '' } },
        raw: (d) => num(d.habits?.steps) },
      { label: '💧 Water (L)', kind: 'num', get: (d) => val(d.habits?.water), raw: (d) => num(d.habits?.water) },
      { label: '💊 Supplements', kind: 'bool', get: (d) => tick(d.habits?.supplements), raw: (d) => d.habits?.supplements },
      { label: '🚫 No cheat meal', kind: 'bool', get: (d) => tick(d.habits?.no_cheat), raw: (d) => d.habits?.no_cheat },
      { label: '🪷 Stress in control', kind: 'bool', get: (d) => tick(d.habits?.stress_ok), raw: (d) => d.habits?.stress_ok },
      { label: '🙂 Mood (1–5)', kind: 'num', get: (d) => val(d.habits?.mood), raw: (d) => num(d.habits?.mood) },
    ],
  },
  {
    title: 'Sleep', bg: 'bg-m4', rows: [
      { label: '🕙 Bed time', kind: 'text', get: (d) => (d.sleep?.bed ? { t: d.sleep.bed } : null) },
      { label: '⏰ Wake time', kind: 'text', get: (d) => (d.sleep?.wake ? { t: d.sleep.wake } : null) },
      { label: '🛏️ Total (h)', kind: 'num',
        get: (d) => { const h = sleepHours(d.sleep?.bed, d.sleep?.wake); return h == null ? null : { t: String(h), c: h >= 7 && h <= 9 ? 'text-emerald-600 font-semibold' : 'text-amber-600' } },
        raw: (d) => sleepHours(d.sleep?.bed, d.sleep?.wake) },
      { label: '📶 Quality (1–5)', kind: 'num', get: (d) => val(d.sleep?.quality), raw: (d) => num(d.sleep?.quality) },
      { label: '🌙 Refreshed', kind: 'bool', get: (d) => tick(d.sleep?.refreshed), raw: (d) => d.sleep?.refreshed },
      { label: '🔋 Energy (1–5)', kind: 'num', get: (d) => val(d.sleep?.energy), raw: (d) => num(d.sleep?.energy) },
      { label: '🧠 Stress (1–5)', kind: 'num', get: (d) => val(d.sleep?.stress), raw: (d) => num(d.sleep?.stress) },
    ],
  },
  {
    title: 'Training', bg: 'bg-m5', rows: [
      { label: '🏋️ Session', kind: 'text',
        get: (d) => (d.training?.type ? { t: TT[d.training.type]?.icon, title: TT[d.training.type]?.label } : null) },
      { label: '✅ Done', kind: 'bool', get: (d) => (d.training?.done ? tick(true) : null), raw: (d) => (d.training?.done ? true : undefined) },
    ],
  },
]

function summary(row, dates, days) {
  if (!row.raw) return ''
  const vals = dates.map((d) => (days[d] ? row.raw(days[d]) : undefined))
  if (row.kind === 'bool') {
    const answered = vals.filter((v) => v === true || v === false).length
    const yes = vals.filter((v) => v === true).length
    return answered ? `${yes}/${answered}` : ''
  }
  const nums = vals.filter((v) => typeof v === 'number')
  if (!nums.length) return ''
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length
  return avg >= 100 ? Math.round(avg).toLocaleString('en-IN') : (Math.round(avg * 10) / 10).toString()
}

export default function MonthGrid({ data, openDay }) {
  const [month, setMonth] = useState(monthOf(today()))
  const { days, client, ensureMonth } = data
  useEffect(() => { ensureMonth(month) }, [month, ensureMonth])
  const dates = monthDays(month)
  const t = today()
  const scroller = useRef(null)

  // bring today's column into view (phones only show ~8 days at once)
  useEffect(() => {
    const el = scroller.current
    const th = el?.querySelector('[data-today]')
    if (el && th) el.scrollLeft = Math.max(0, th.offsetLeft - el.clientWidth / 2)
    else if (el) el.scrollLeft = 0
  }, [month])

  return (
    <div className="space-y-3">
      <div className="card p-1.5 flex items-center gap-1">
        <button aria-label="Previous month" className="btn-ghost border-0 w-11 px-0 text-lg" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
        <div className="flex-1 text-center font-head text-lg font-semibold uppercase">{fmtMonth(month)}</div>
        <button aria-label="Next month" className="btn-ghost border-0 w-11 px-0 text-lg" onClick={() => setMonth(addMonths(month, 1))}>›</button>
      </div>

      <div ref={scroller} className="card overflow-x-auto overscroll-x-contain">
        <table className="text-xs border-collapse min-w-max">
          <thead>
            <tr className="bg-ink text-white">
              <th className="sticky left-0 z-10 bg-ink text-left px-3 py-2 font-head uppercase tracking-wide text-sm">Date</th>
              {dates.map((d) => (
                <th key={d} data-today={d === t ? '' : undefined} className={`w-9 min-w-[2.25rem] px-0.5 py-2 font-bold ${d === t ? 'bg-brand' : ''}`}>
                  <button className="w-full py-1 hover:underline" onClick={() => openDay(d)} title="Open this day">{parse(d).getDate()}</button>
                </th>
              ))}
              <th className="px-2 py-2 font-head uppercase tracking-wide">Avg / ✓</th>
            </tr>
          </thead>
          {GROUPS(client).map((g) => (
            <tbody key={g.title}>
              <tr><td colSpan={dates.length + 2} className={`${g.bg} py-1 font-head font-semibold uppercase tracking-wide text-[0.8rem]`}><span className="sticky left-0 inline-block px-3">{g.title}</span></td></tr>
              {g.rows.map((r) => (
                <tr key={r.label} className="border-t border-neutral-100">
                  <td title={r.label} className={`sticky left-0 z-10 ${g.bg} px-2 sm:px-3 py-2 font-semibold whitespace-nowrap max-w-[7.5rem] sm:max-w-none truncate shadow-[2px_0_4px_-2px_rgba(0,0,0,0.15)]`}>{r.label}</td>
                  {dates.map((d) => {
                    const c = days[d] ? r.get(days[d]) : null
                    return (
                      <td key={d} title={c?.title} onClick={() => openDay(d)}
                        className={`text-center px-0.5 py-2 cursor-pointer hover:bg-neutral-100 border-l border-neutral-100 ${d === t ? 'bg-red-50' : ''} ${c?.c || ''}`}>
                        {c?.t ?? ''}
                      </td>
                    )
                  })}
                  <td className="px-2 py-1.5 text-center font-semibold border-l border-neutral-200 bg-neutral-50">{summary(r, dates, days)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="text-xs text-neutral-500 px-1">Swipe sideways to see the whole month. Tap a day to open it.</p>
    </div>
  )
}
