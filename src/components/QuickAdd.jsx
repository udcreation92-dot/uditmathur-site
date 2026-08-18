import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { parseQuickTask } from '../utils/parseQuickTask'

// Fast single-line task capture. Type e.g. "Pay rent tomorrow 9-11am 15m @home"
export default function QuickAdd({ locations = [], onSaved }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const parsed = useMemo(() => (text.trim() ? parseQuickTask(text) : null), [text])

  async function resolveLocationId(name) {
    if (!name) return null
    const hit = locations.find(l => l.name.toLowerCase() === name.toLowerCase())
    if (hit) return hit.id
    const canonical = name.charAt(0).toUpperCase() + name.slice(1)
    const { data } = await supabase.from('locations').insert({ name: canonical }).select('id').single()
    return data?.id ?? null
  }

  async function submit(e) {
    e?.preventDefault()
    if (!parsed || !parsed.title) { setErr('Type a task title.'); return }
    setSaving(true); setErr('')
    const location_id = await resolveLocationId(parsed.locationName)
    const today = new Date()
    const startDate = parsed.start_date || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const payload = {
      title: parsed.title,
      description: '',
      start_time: parsed.start_time,
      end_time: parsed.end_time,
      start_date: startDate,
      due_date: parsed.due_date || startDate, // smart default: due = start
      duration_minutes: parsed.duration_minutes || 0,
      is_recurring: parsed.is_recurring,
      recurrence: parsed.recurrence,
      prerequisite_ids: [],
      status: 'pending',
      location_id,
      location_ids: location_id ? [location_id] : [],
    }
    const { error } = await supabase.from('tasks').insert(payload)
    setSaving(false)
    if (error) { setErr(error.message); return }
    setText('')
    onSaved?.()
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-xl border border-slate-200 shadow-sm p-2">
      <div className="flex items-center gap-2">
        <span className="pl-2 text-slate-400">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" strokeLinecap="round"/></svg>
        </span>
        <input
          className="flex-1 bg-transparent outline-none text-sm text-slate-800 placeholder-slate-400 py-2"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Quick add: pay rent tomorrow 9-11am 15m @home"
        />
        <button
          type="submit"
          disabled={saving || !parsed?.title}
          className="shrink-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          {saving ? '…' : 'Add'}
        </button>
      </div>

      {/* Live parse preview */}
      {parsed?.title && (
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 px-2 pt-1.5 pb-1 text-xs">
          <span className="font-medium text-slate-700 truncate max-w-[60%]">{parsed.title}</span>
          {parsed.preview && <span className="text-slate-400">{parsed.preview}</span>}
        </div>
      )}
      {err && <p className="px-2 pt-1 text-xs text-red-600">{err}</p>}
      {!text && (
        <p className="px-2 pt-1 pb-0.5 text-[11px] text-slate-400">
          Tip: <span className="text-slate-500">tomorrow · 9-11am · by 6pm · 15m / 2h · @location · daily / every mon</span>
        </p>
      )}
    </form>
  )
}
