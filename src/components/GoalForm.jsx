import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import PrereqSelect from './PrereqSelect'

const pad = (n) => String(n).padStart(2, '0')
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const shiftISO = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

const DUR_PRESETS = [['5m', 5], ['15m', 15], ['30m', 30], ['1h', 60], ['2h', 120]]
const START_TIMES = ['09:00', '10:00', '12:00', '15:00', '18:00']
const END_TIMES = ['12:00', '15:00', '17:00', '18:00', '21:00']

let UID = 0
const newStep = () => ({
  uid: ++UID, title: '', open: false,
  duration_minutes: 0, start_time: '', end_time: '',
  start_date: todayISO(), due_date: '',
  prereqSteps: [], prereqTasks: [],
})

export default function GoalForm({ tasks = [], onClose, onSaved }) {
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [steps, setSteps] = useState(() => [newStep(), newStep(), newStep()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const rowRefs = useRef([])

  const patchStep = (uid, patch) => setSteps(s => s.map(x => x.uid === uid ? { ...x, ...patch } : x))
  const setField = (uid, key, val) => patchStep(uid, { [key]: val })
  const toggleInArr = (uid, key, val) => setSteps(s => s.map(x => {
    if (x.uid !== uid) return x
    const arr = x[key].includes(val) ? x[key].filter(v => v !== val) : [...x[key], val]
    return { ...x, [key]: arr }
  }))
  const addStep = () => setSteps(s => [...s, newStep()])
  const removeStep = (uid) => setSteps(s => {
    const next = (s.length > 1 ? s.filter(x => x.uid !== uid) : s)
    // drop this step from any sibling's prereqSteps
    return next.map(x => ({ ...x, prereqSteps: x.prereqSteps.filter(k => k !== uid) }))
  })

  function onTitleKey(e, i) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (i === steps.length - 1) addStep()
      setTimeout(() => rowRefs.current[i + 1]?.focus(), 0)
    }
  }

  const siblingsFor = (uid) =>
    steps.filter(s => s.uid !== uid && s.title.trim()).map(s => ({ key: s.uid, label: s.title.trim() }))

  async function save() {
    const goalTitle = title.trim()
    const clean = steps.filter(s => s.title.trim())
    if (!goalTitle) { setError('Give the goal a title.'); return }
    if (!clean.length) { setError('Add at least one step.'); return }
    setSaving(true); setError('')

    const { data: parent, error: pe } = await supabase.from('tasks')
      .insert({ title: goalTitle, due_date: dueDate || null, status: 'pending' })
      .select('id').single()
    if (pe) { setError(pe.message); setSaving(false); return }

    // Create each step, remembering uid -> new id for sibling prerequisites.
    const uidToId = {}
    for (const s of clean) {
      const { data: child, error: ce } = await supabase.from('tasks').insert({
        title: s.title.trim(), parent_id: parent.id, status: 'pending',
        start_date: s.start_date || null, due_date: s.due_date || null,
        start_time: s.start_time || null, end_time: s.end_time || null,
        duration_minutes: s.duration_minutes || 0,
      }).select('id').single()
      if (ce) { setError(ce.message); setSaving(false); return }
      uidToId[s.uid] = child.id
    }
    // Link prerequisites (sibling uids resolved to new ids + existing task ids).
    for (const s of clean) {
      const ids = [
        ...s.prereqSteps.map(uid => uidToId[uid]).filter(Boolean),
        ...s.prereqTasks,
      ]
      if (ids.length) await supabase.from('tasks').update({ prerequisite_ids: ids }).eq('id', uidToId[s.uid])
    }

    setSaving(false)
    onSaved?.()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose}>
      <div className="bg-white w-full md:max-w-lg md:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-800">🎯 New Goal</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Goal</label>
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Clean the AC"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Goal deadline (optional)</label>
            <div className="flex gap-1.5 items-center flex-wrap">
              <Chip active={dueDate === todayISO()} onClick={() => setDueDate(todayISO())}>Today</Chip>
              <Chip active={dueDate === shiftISO(1)} onClick={() => setDueDate(shiftISO(1))}>Tomorrow</Chip>
              <Chip active={dueDate === shiftISO(7)} onClick={() => setDueDate(shiftISO(7))}>+1 week</Chip>
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                className="px-2 py-1 border border-slate-200 rounded-lg text-sm bg-white" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Steps</label>
            <p className="text-xs text-slate-400 mb-2">Type a title, press Enter for the next. Tap <b>Details</b> on any step to set duration, times, dates and prerequisites — use the quick chips.</p>

            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={s.uid} className="rounded-lg border border-slate-150 bg-slate-50/60">
                  <div className="flex items-center gap-2 p-2">
                    <span className="text-xs text-slate-400 w-4 text-right">{i + 1}</span>
                    <input
                      ref={el => (rowRefs.current[i] = el)}
                      value={s.title}
                      onChange={e => setField(s.uid, 'title', e.target.value)}
                      onKeyDown={e => onTitleKey(e, i)}
                      placeholder={`Step ${i + 1}`}
                      className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                    <button onClick={() => patchStep(s.uid, { open: !s.open })}
                      className={`text-xs px-2 py-1 rounded-md ${s.open ? 'bg-indigo-600 text-white' : 'text-indigo-600 hover:bg-indigo-50'}`}>
                      Details
                    </button>
                    <button onClick={() => removeStep(s.uid)} className="text-slate-300 hover:text-red-500 text-lg leading-none px-1" title="Remove">×</button>
                  </div>

                  {s.open && (
                    <div className="px-3 pb-3 pt-1 ml-6 space-y-3 border-l-2 border-indigo-100">
                      {/* Duration */}
                      <Detail label="Duration">
                        {DUR_PRESETS.map(([l, v]) => (
                          <Chip key={v} active={s.duration_minutes === v} onClick={() => setField(s.uid, 'duration_minutes', v)}>{l}</Chip>
                        ))}
                        <input type="number" min="0" value={s.duration_minutes || ''} placeholder="min"
                          onChange={e => setField(s.uid, 'duration_minutes', Number(e.target.value) || 0)}
                          className="w-16 px-2 py-1 border border-slate-200 rounded-lg text-sm bg-white" />
                      </Detail>

                      {/* Start date */}
                      <Detail label="Start date">
                        <Chip active={s.start_date === todayISO()} onClick={() => setField(s.uid, 'start_date', todayISO())}>Today</Chip>
                        <Chip active={s.start_date === shiftISO(1)} onClick={() => setField(s.uid, 'start_date', shiftISO(1))}>Tomorrow</Chip>
                        <input type="date" value={s.start_date} onChange={e => setField(s.uid, 'start_date', e.target.value)}
                          className="px-2 py-1 border border-slate-200 rounded-lg text-sm bg-white" />
                      </Detail>

                      {/* Due date */}
                      <Detail label="Due date (deadline)">
                        <Chip active={s.due_date === s.start_date} onClick={() => setField(s.uid, 'due_date', s.start_date)}>Same day</Chip>
                        <Chip active={s.due_date === shiftISO(1)} onClick={() => setField(s.uid, 'due_date', shiftISO(1))}>Tomorrow</Chip>
                        <Chip active={s.due_date === shiftISO(3)} onClick={() => setField(s.uid, 'due_date', shiftISO(3))}>+3d</Chip>
                        <input type="date" value={s.due_date} onChange={e => setField(s.uid, 'due_date', e.target.value)}
                          className="px-2 py-1 border border-slate-200 rounded-lg text-sm bg-white" />
                      </Detail>

                      {/* Times */}
                      <Detail label="Start time">
                        {START_TIMES.map(t => (
                          <Chip key={t} active={s.start_time === t} onClick={() => setField(s.uid, 'start_time', t)}>{t}</Chip>
                        ))}
                        <input type="time" value={s.start_time} onChange={e => setField(s.uid, 'start_time', e.target.value)}
                          className="px-2 py-1 border border-slate-200 rounded-lg text-sm bg-white" />
                      </Detail>
                      <Detail label="End time (deadline)">
                        {END_TIMES.map(t => (
                          <Chip key={t} active={s.end_time === t} onClick={() => setField(s.uid, 'end_time', t)}>{t}</Chip>
                        ))}
                        <input type="time" value={s.end_time} onChange={e => setField(s.uid, 'end_time', e.target.value)}
                          className="px-2 py-1 border border-slate-200 rounded-lg text-sm bg-white" />
                      </Detail>

                      {/* Prerequisites */}
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-1">Prerequisites (done first)</p>
                        <PrereqSelect
                          allTasks={tasks}
                          siblings={siblingsFor(s.uid)}
                          selectedSiblingKeys={s.prereqSteps}
                          onToggleSibling={(k) => toggleInArr(s.uid, 'prereqSteps', k)}
                          selectedTaskIds={s.prereqTasks}
                          onToggleTask={(id) => toggleInArr(s.uid, 'prereqTasks', id)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button onClick={addStep} className="mt-2 text-sm text-indigo-600 hover:text-indigo-800">+ Add step</button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex gap-3 px-5 py-4 border-t border-slate-100">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50">Cancel</button>
          <button onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60">
            {saving ? 'Creating…' : 'Create Goal'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={`text-xs px-2 py-1 rounded-full border transition-colors ${
        active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-400'
      }`}>
      {children}
    </button>
  )
}

function Detail({ label, children }) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-500 mb-1">{label}</p>
      <div className="flex flex-wrap gap-1.5 items-center">{children}</div>
    </div>
  )
}
