import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

// Fast goal creation: type the goal title + a list of step titles, hit save. Steps are
// created as sub-tasks (title only). You then tap any step to fill in its details
// (duration, times, dates, prerequisites) in the normal task editor.
export default function GoalForm({ onClose, onSaved }) {
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [steps, setSteps] = useState(['', '', ''])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const rowRefs = useRef([])

  const setStep = (i, v) => setSteps(s => s.map((x, idx) => (idx === i ? v : x)))
  const addStep = () => setSteps(s => [...s, ''])
  const removeStep = (i) => setSteps(s => (s.length > 1 ? s.filter((_, idx) => idx !== i) : s))

  function onStepKey(e, i) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (i === steps.length - 1) addStep()
      setTimeout(() => rowRefs.current[i + 1]?.focus(), 0)
    }
  }

  async function save() {
    const goalTitle = title.trim()
    const cleanSteps = steps.map(s => s.trim()).filter(Boolean)
    if (!goalTitle) { setError('Give the goal a title.'); return }
    if (cleanSteps.length === 0) { setError('Add at least one step.'); return }
    setSaving(true); setError('')

    const { data: parent, error: pe } = await supabase.from('tasks')
      .insert({ title: goalTitle, due_date: dueDate || null, status: 'pending' })
      .select('id').single()
    if (pe) { setError(pe.message); setSaving(false); return }

    const rows = cleanSteps.map(t => ({ title: t, parent_id: parent.id, status: 'pending' }))
    const { error: ce } = await supabase.from('tasks').insert(rows)
    if (ce) { setError(ce.message); setSaving(false); return }

    setSaving(false)
    onSaved?.()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose}>
      <div
        className="bg-white w-full md:max-w-lg md:rounded-2xl rounded-t-2xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-800">🎯 New Goal</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Goal</label>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Clean the AC"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Goal deadline (optional)</label>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Steps</label>
            <p className="text-xs text-slate-400 mb-2">Just the titles for now — press Enter to add a row. You can open each step afterwards to set duration, times, dates and prerequisites.</p>
            <div className="space-y-1.5">
              {steps.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 w-4 text-right">{i + 1}</span>
                  <input
                    ref={el => (rowRefs.current[i] = el)}
                    value={s}
                    onChange={e => setStep(i, e.target.value)}
                    onKeyDown={e => onStepKey(e, i)}
                    placeholder={`Step ${i + 1}`}
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                  <button
                    onClick={() => removeStep(i)}
                    className="text-slate-300 hover:text-red-500 text-lg leading-none px-1"
                    title="Remove"
                  >×</button>
                </div>
              ))}
            </div>
            <button onClick={addStep} className="mt-2 text-sm text-indigo-600 hover:text-indigo-800">+ Add step</button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex gap-3 px-5 py-4 border-t border-slate-100">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60"
          >
            {saving ? 'Creating…' : 'Create Goal'}
          </button>
        </div>
      </div>
    </div>
  )
}
