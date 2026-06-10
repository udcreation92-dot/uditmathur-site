import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const DEFAULT_FORM = {
  title: '',
  description: '',
  start_time: '',
  end_time: '',
  start_date: '',
  due_date: '',
  duration_hours: '',
  duration_minutes_extra: '',
  location_id: '',
  is_recurring: false,
  freq: 'daily',
  weekly_days: [],
  monthly_day: '1',
  yearly_month: '1',
  yearly_day: '1',
  prerequisite_ids: [],
  status: 'pending',
}

function toForm(task) {
  if (!task) return DEFAULT_FORM
  const rec = task.recurrence || {}
  return {
    title: task.title || '',
    description: task.description || '',
    start_time: task.start_time || '',
    end_time: task.end_time || '',
    start_date: task.start_date || '',
    due_date: task.due_date || '',
    duration_hours: task.duration_minutes ? String(Math.floor(task.duration_minutes / 60)) : '',
    duration_minutes_extra: task.duration_minutes ? String(task.duration_minutes % 60) : '',
    is_recurring: task.is_recurring || false,
    freq: rec.frequency || 'daily',
    weekly_days: rec.days || [],
    monthly_day: String(rec.day || 1),
    yearly_month: String(rec.month || 1),
    yearly_day: String(rec.day || 1),
    prerequisite_ids: task.prerequisite_ids || [],
    status: task.status || 'pending',
    location_id: task.location_id || '',
  }
}

export default function TaskForm({ task, tasks, locations = [], onClose, onSave }) {
  const [form, setForm] = useState(() => toForm(task))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isEdit = !!task

  // Eligible prerequisite tasks (exclude self and already completed ones shown for edit)
  const prereqOptions = tasks.filter(t => t.id !== task?.id && t.status !== 'cancelled')

  function set(key, value) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function toggleDay(day) {
    set('weekly_days',
      form.weekly_days.includes(day)
        ? form.weekly_days.filter(d => d !== day)
        : [...form.weekly_days, day].sort()
    )
  }

  function togglePrereq(id) {
    set('prerequisite_ids',
      form.prerequisite_ids.includes(id)
        ? form.prerequisite_ids.filter(x => x !== id)
        : [...form.prerequisite_ids, id]
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) { setError('Title is required.'); return }

    setSaving(true)
    setError('')

    const totalMins =
      (parseInt(form.duration_hours) || 0) * 60 +
      (parseInt(form.duration_minutes_extra) || 0)

    let recurrence = null
    if (form.is_recurring) {
      switch (form.freq) {
        case 'daily':
          recurrence = { frequency: 'daily' }
          break
        case 'weekly':
          recurrence = { frequency: 'weekly', days: form.weekly_days }
          break
        case 'monthly':
          recurrence = { frequency: 'monthly', day: parseInt(form.monthly_day) }
          break
        case 'yearly':
          recurrence = { frequency: 'yearly', month: parseInt(form.yearly_month), day: parseInt(form.yearly_day) }
          break
      }
    }

    const payload = {
      title: form.title.trim(),
      description: form.description.trim(),
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      start_date: form.start_date || null,
      due_date: form.due_date || null,
      duration_minutes: totalMins,
      is_recurring: form.is_recurring,
      recurrence,
      prerequisite_ids: form.prerequisite_ids,
      status: form.status,
      location_id: form.location_id || null,
    }

    const { error: dbError } = isEdit
      ? await supabase.from('tasks').update(payload).eq('id', task.id)
      : await supabase.from('tasks').insert(payload)

    setSaving(false)

    if (dbError) { setError(dbError.message); return }

    onSave()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-800">{isEdit ? 'Edit Task' : 'New Task'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-5 py-4 space-y-4">

          {/* Title */}
          <Field label="Title *">
            <input
              className="input"
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="What needs to be done?"
              autoFocus
            />
          </Field>

          {/* Description */}
          <Field label="Description">
            <textarea
              className="input resize-none"
              rows={2}
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="Optional details..."
            />
          </Field>

          {/* Location */}
          {locations.length > 0 && (
            <Field label="Location">
              <select className="input" value={form.location_id} onChange={e => set('location_id', e.target.value)}>
                <option value="">No location</option>
                {locations.map(loc => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))}
              </select>
            </Field>
          )}

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start Date">
              <input type="date" className="input" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
            </Field>
            <Field label="Due Date">
              <input type="date" className="input" value={form.due_date} onChange={e => set('due_date', e.target.value)} />
            </Field>
          </div>

          {/* Time frame */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start Time">
              <input type="time" className="input" value={form.start_time} onChange={e => set('start_time', e.target.value)} />
            </Field>
            <Field label="End Time">
              <input type="time" className="input" value={form.end_time} onChange={e => set('end_time', e.target.value)} />
            </Field>
          </div>

          {/* Duration */}
          <Field label="Time to Complete">
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  type="number" min="0" className="input pr-8"
                  placeholder="0"
                  value={form.duration_hours}
                  onChange={e => set('duration_hours', e.target.value)}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">h</span>
              </div>
              <div className="flex-1 relative">
                <input
                  type="number" min="0" max="59" className="input pr-8"
                  placeholder="0"
                  value={form.duration_minutes_extra}
                  onChange={e => set('duration_minutes_extra', e.target.value)}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">m</span>
              </div>
            </div>
          </Field>

          {/* Recurring toggle */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => set('is_recurring', !form.is_recurring)}
              className={`w-10 h-6 rounded-full transition-colors relative ${form.is_recurring ? 'bg-purple-600' : 'bg-slate-200'}`}
            >
              <span className={`block w-4 h-4 bg-white rounded-full shadow absolute top-1 transition-transform ${form.is_recurring ? 'left-5' : 'left-1'}`} />
            </button>
            <span className="text-sm font-medium text-slate-700">Recurring task</span>
          </div>

          {form.is_recurring && (
            <div className="bg-purple-50 rounded-xl p-4 space-y-3 border border-purple-100">
              {/* Frequency */}
              <Field label="Frequency">
                <select className="input" value={form.freq} onChange={e => set('freq', e.target.value)}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </Field>

              {form.freq === 'weekly' && (
                <Field label="On these days">
                  <div className="flex gap-2 flex-wrap">
                    {WEEKDAYS.map((day, i) => (
                      <button
                        key={i} type="button"
                        onClick={() => toggleDay(i)}
                        className={`px-2.5 py-1 rounded-lg text-sm font-medium transition-colors ${
                          form.weekly_days.includes(i)
                            ? 'bg-purple-600 text-white'
                            : 'bg-white border border-slate-200 text-slate-600'
                        }`}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </Field>
              )}

              {form.freq === 'monthly' && (
                <Field label="Day of month">
                  <input
                    type="number" min="1" max="31" className="input w-24"
                    value={form.monthly_day}
                    onChange={e => set('monthly_day', e.target.value)}
                  />
                </Field>
              )}

              {form.freq === 'yearly' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Month">
                    <select className="input" value={form.yearly_month} onChange={e => set('yearly_month', e.target.value)}>
                      {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                    </select>
                  </Field>
                  <Field label="Day">
                    <input
                      type="number" min="1" max="31" className="input"
                      value={form.yearly_day}
                      onChange={e => set('yearly_day', e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          {/* Status (edit only) */}
          {isEdit && (
            <Field label="Status">
              <select className="input" value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
          )}

          {/* Prerequisites */}
          {prereqOptions.length > 0 && (
            <Field label="Prerequisites (must be done first)">
              <div className="max-h-36 overflow-y-auto space-y-1 border border-slate-200 rounded-lg p-2 bg-slate-50">
                {prereqOptions.map(t => (
                  <label key={t.id} className="flex items-center gap-2 cursor-pointer py-0.5">
                    <input
                      type="checkbox"
                      checked={form.prerequisite_ids.includes(t.id)}
                      onChange={() => togglePrereq(t.id)}
                      className="rounded"
                    />
                    <span className="text-sm text-slate-700 truncate">{t.title}</span>
                    {t.status === 'completed' && (
                      <span className="text-xs text-green-600 ml-auto shrink-0">✓ done</span>
                    )}
                  </label>
                ))}
              </div>
            </Field>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 border-t border-slate-100">
          <button
            type="button" onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors disabled:opacity-60"
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Task'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{label}</label>
      {children}
    </div>
  )
}
