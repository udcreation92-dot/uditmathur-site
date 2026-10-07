import { useEffect, useState } from 'react'
import { Card, Check } from './ui'
import { addMonths, fmtMonth, monthOf, today, weekLabel } from '../lib/dates'

const MEASURES = [
  { k: 'weight', label: '⚖️ Weight', unit: 'kg' },
  { k: 'waist', label: '📏 Waist', unit: 'cm' },
  { k: 'chest', label: '🏋️ Chest', unit: 'cm' },
  { k: 'hip', label: '🏋️ Hip', unit: 'cm' },
]
const NOTES = [
  { k: 'physical', label: '🧍 Physical changes' },
  { k: 'performance', label: '📶 Performance / energy' },
  { k: 'mental', label: '❤️ Mental wellbeing' },
  { k: 'observations', label: '📋 Key observations' },
]
const LIST_LEN = 5

export default function CheckIn({ data }) {
  const [month, setMonth] = useState(monthOf(today()))
  const { months, ensureMonth, setMonthKey } = data
  useEffect(() => { ensureMonth(month) }, [month, ensureMonth])

  const md = months[month] || {}
  const weeks = Array.from({ length: 4 }, (_, i) => md.weeks?.[i] || {})
  const setWeek = (i, patch) => setMonthKey(month, 'weeks', weeks.map((w, j) => (j === i ? { ...w, ...patch } : w)))

  return (
    <div className="space-y-4">
      <div className="card p-3 flex items-center gap-2">
        <button className="btn-ghost px-3" onClick={() => setMonth(addMonths(month, -1))}>◀</button>
        <div className="flex-1 text-center font-head text-xl font-semibold uppercase">{fmtMonth(month)}</div>
        <button className="btn-ghost px-3" onClick={() => setMonth(addMonths(month, 1))}>▶</button>
      </div>

      <Card icon="📅" title="Weekly check-in & results">
        {/* measurements: metric rows × 4 week columns */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[34rem]">
            <thead>
              <tr className="bg-neutral-50 text-left">
                <th className="px-3 py-2 font-head uppercase tracking-wide">Metric</th>
                {weeks.map((_, i) => (
                  <th key={i} className="px-2 py-2 text-center">
                    <div className="font-head uppercase tracking-wide">Week {i + 1}</div>
                    <div className="text-[0.65rem] font-normal text-neutral-500">{weekLabel(month, i)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MEASURES.map((m) => (
                <tr key={m.k} className="border-t border-neutral-100">
                  <td className="px-3 py-2 font-semibold whitespace-nowrap bg-m1/60">{m.label} <span className="text-xs text-neutral-500">({m.unit})</span></td>
                  {weeks.map((w, i) => (
                    <td key={i} className="px-2 py-1.5">
                      <input className="inp text-center px-1" type="number" inputMode="decimal" step="0.1"
                        value={w[m.k] ?? ''} onChange={(e) => setWeek(i, { [m.k]: e.target.value })} />
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-neutral-100">
                <td className="px-3 py-2 font-semibold bg-m1/60">📷 Progress photo</td>
                {weeks.map((w, i) => (
                  <td key={i} className="px-2 py-1.5"><Check className="mx-auto" checked={!!w.photo} onChange={(v) => setWeek(i, { photo: v })} /></td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid sm:grid-cols-2 gap-4">
        {weeks.map((w, i) => (
          <Card key={i} icon="📝" title={`Week ${i + 1}`} right={<span className="text-xs text-neutral-400">{weekLabel(month, i)}</span>}>
            <div className="p-4 space-y-3">
              {NOTES.map((n) => (
                <label key={n.k} className="block">
                  <span className="lbl">{n.label}</span>
                  <textarea className="inp" rows={2} value={w[n.k] || ''} onChange={(e) => setWeek(i, { [n.k]: e.target.value })} />
                </label>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <Card icon="🗒️" title="Notes / observations">
        <div className="p-4">
          <textarea className="inp" rows={3} value={md.notes || ''} onChange={(e) => setMonthKey(month, 'notes', e.target.value)} />
        </div>
      </Card>

      <div className="grid sm:grid-cols-2 gap-4">
        <ListCard icon="🏆" title="Achievements / positives" bg="bg-m1" items={md.achievements} onChange={(v) => setMonthKey(month, 'achievements', v)} />
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
      <div className={`${bg} p-4 space-y-2`}>
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
