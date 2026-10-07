import { useEffect, useState } from 'react'
import { Card, Check } from './ui'
import { addMonths, fmtMonth, monthOf, parse, today, weekLabel } from '../lib/dates'
import { num } from '../lib/constants'

const MEASURES = [
  { k: 'weight', label: 'Weight', icon: '⚖️', unit: 'kg' },
  { k: 'waist', label: 'Waist', icon: '📏', unit: 'cm' },
  { k: 'chest', label: 'Chest', icon: '🫁', unit: 'cm' },
  { k: 'hip', label: 'Hip', icon: '🍑', unit: 'cm' },
]
const NOTES = [
  { k: 'physical', label: '🧍 Physical changes' },
  { k: 'performance', label: '📶 Performance / energy' },
  { k: 'mental', label: '❤️ Mental wellbeing' },
  { k: 'observations', label: '📋 Key observations' },
]
const LIST_LEN = 5
const currentWeekIdx = () => Math.min(3, Math.floor((parse(today()).getDate() - 1) / 7))

export default function CheckIn({ data }) {
  const [month, setMonth] = useState(monthOf(today()))
  const [wk, setWk] = useState(currentWeekIdx())
  const { months, ensureMonth, setMonthKey } = data
  useEffect(() => { ensureMonth(month) }, [month, ensureMonth])

  const md = months[month] || {}
  const weeks = Array.from({ length: 4 }, (_, i) => md.weeks?.[i] || {})
  const w = weeks[wk]
  const setWeek = (i, patch) => setMonthKey(month, 'weeks', weeks.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const goMonth = (n) => { setMonth(addMonths(month, n)); setWk(n > 0 ? 0 : 3) }

  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="card p-1.5 flex items-center gap-1">
        <button aria-label="Previous month" className="btn-ghost border-0 w-11 px-0 text-lg" onClick={() => goMonth(-1)}>‹</button>
        <div className="flex-1 text-center font-head text-lg font-semibold uppercase">{fmtMonth(month)}</div>
        <button aria-label="Next month" className="btn-ghost border-0 w-11 px-0 text-lg" onClick={() => goMonth(1)}>›</button>
      </div>

      {/* progress at a glance */}
      <Card icon="📈" title="Progress this month">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[0.68rem] uppercase tracking-wider text-neutral-500">
              <th className="text-left font-semibold px-3 py-2" />
              {weeks.map((_, i) => <th key={i} className={`font-semibold px-1 py-2 ${i === wk ? 'text-brand' : ''}`}>Wk {i + 1}</th>)}
              <th className="font-semibold px-2 py-2">Δ</th>
            </tr>
          </thead>
          <tbody>
            {MEASURES.map((m) => {
              const vals = weeks.map((x) => num(x[m.k]))
              const known = vals.filter((v) => v != null)
              const delta = known.length > 1 ? Math.round((known[known.length - 1] - known[0]) * 10) / 10 : null
              return (
                <tr key={m.k} className="border-t border-neutral-100">
                  <td className="px-3 py-2 font-semibold whitespace-nowrap">{m.icon} {m.label}</td>
                  {vals.map((v, i) => <td key={i} className={`text-center px-1 py-2 tabular-nums ${i === wk ? 'bg-red-50/60' : ''}`}>{v ?? <span className="text-neutral-300">–</span>}</td>)}
                  <td className={`text-center px-2 py-2 font-semibold tabular-nums ${delta == null ? 'text-neutral-300' : delta < 0 ? 'text-emerald-600' : delta > 0 ? 'text-amber-600' : ''}`}>
                    {delta == null ? '–' : `${delta > 0 ? '+' : ''}${delta}`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      {/* week picker */}
      <div className="grid grid-cols-4 gap-1.5">
        {weeks.map((x, i) => {
          const filled = Object.values(x).some((v) => v !== '' && v != null && v !== false)
          return (
            <button key={i} onClick={() => setWk(i)}
              className={`rounded-xl border py-2 text-center ${i === wk ? 'bg-ink border-ink text-white' : 'bg-white border-neutral-200'}`}>
              <div className="font-head font-semibold uppercase text-sm">Week {i + 1}</div>
              <div className="text-[0.62rem] opacity-70">{weekLabel(month, i)}</div>
              <div className={`mx-auto mt-0.5 w-1.5 h-1.5 rounded-full ${filled ? 'bg-emerald-500' : 'bg-transparent'}`} />
            </button>
          )
        })}
      </div>

      <Card icon="📅" title={`Week ${wk + 1} check-in`} right={<span className="text-xs text-neutral-400">{weekLabel(month, wk)}</span>}>
        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {MEASURES.map((m) => (
            <label key={m.k} className="block">
              <span className="lbl">{m.icon} {m.label} ({m.unit})</span>
              <input className="inp text-center" type="number" inputMode="decimal" step="0.1"
                value={w[m.k] ?? ''} onChange={(e) => setWeek(wk, { [m.k]: e.target.value })} />
            </label>
          ))}
          <div className="col-span-2 sm:col-span-4">
            <Check checked={!!w.photo} onChange={(v) => setWeek(wk, { photo: v })} label="📷 Progress photo taken" />
          </div>
          {NOTES.map((n) => (
            <label key={n.k} className="block col-span-2">
              <span className="lbl">{n.label}</span>
              <textarea className="inp" rows={2} value={w[n.k] || ''} onChange={(e) => setWeek(wk, { [n.k]: e.target.value })} />
            </label>
          ))}
        </div>
      </Card>

      <Card icon="🗒️" title="Month notes">
        <div className="p-4">
          <textarea className="inp" rows={3} value={md.notes || ''} onChange={(e) => setMonthKey(month, 'notes', e.target.value)} />
        </div>
      </Card>

      <div className="grid sm:grid-cols-2 gap-3 sm:gap-4">
        <ListCard icon="🏆" title="Achievements" bg="bg-m1" items={md.achievements} onChange={(v) => setMonthKey(month, 'achievements', v)} />
        <ListCard icon="🎯" title="Next month focus" bg="bg-m4" items={md.focus} onChange={(v) => setMonthKey(month, 'focus', v)} />
      </div>
    </div>
  )
}

function ListCard({ icon, title, bg, items, onChange }) {
  const list = Array.from({ length: LIST_LEN }, (_, i) => items?.[i] || {})
  const set = (i, patch) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  return (
    <Card icon={icon} title={title}>
      <div className={`${bg} p-3 space-y-1`}>
        {list.map((x, i) => (
          <div key={i} className="flex items-center gap-2">
            <Check checked={!!x.done} onChange={(v) => set(i, { done: v })} />
            <input className={`inp ${x.done ? 'line-through text-neutral-500' : ''}`} value={x.text || ''} onChange={(e) => set(i, { text: e.target.value })} />
          </div>
        ))}
      </div>
    </Card>
  )
}
