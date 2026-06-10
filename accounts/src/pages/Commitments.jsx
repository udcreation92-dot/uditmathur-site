import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'
import { format, addDays, parseISO } from 'date-fns'

// ─── constants ────────────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const NTH  = [
  { value: 1,  label: '1st' },
  { value: 2,  label: '2nd' },
  { value: 3,  label: '3rd' },
  { value: 4,  label: '4th' },
  { value: -1, label: 'Last' },
]

// ─── helpers ─────────────────────────────────────────────────────────────────

export function describeRecurrence(rec) {
  if (!rec) return ''
  if (rec.freq === 'weekly') return `Every ${DAYS[rec.weekday]}`
  if (rec.freq === 'monthly' && rec.day !== undefined) {
    const d = rec.day
    const s = d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th'
    return `${d}${s} of every month`
  }
  if (rec.freq === 'monthly' && rec.nth !== undefined) {
    const nth = rec.nth === -1 ? 'Last' : (NTH.find(n => n.value === rec.nth)?.label || '')
    return `${nth} ${DAYS[rec.weekday]} of every month`
  }
  return 'Recurring'
}

function getNthWeekdayOfMonth(year, month, weekday, nth) {
  if (nth === -1) {
    const last = new Date(year, month + 1, 0)
    const offset = (last.getDay() - weekday + 7) % 7
    return new Date(year, month, last.getDate() - offset)
  }
  const first = new Date(year, month, 1)
  const daysUntil = (weekday - first.getDay() + 7) % 7
  return new Date(year, month, 1 + daysUntil + (nth - 1) * 7)
}

function getNextDueDate(commitment) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  if (commitment.commitment_type === 'one_time') {
    const d = parseISO(commitment.due_date)
    return d >= today ? d : null
  }
  const rec = commitment.recurrence
  if (!rec) return null

  if (rec.freq === 'weekly') {
    const diff = (rec.weekday - today.getDay() + 7) % 7
    return diff === 0 ? today : addDays(today, diff)
  }
  if (rec.freq === 'monthly' && rec.day !== undefined) {
    let d = new Date(today.getFullYear(), today.getMonth(), rec.day)
    if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, rec.day)
    return d
  }
  if (rec.freq === 'monthly' && rec.nth !== undefined) {
    let yr = today.getFullYear()
    let mo = today.getMonth()
    for (let i = 0; i < 24; i++) {
      const candidate = getNthWeekdayOfMonth(yr, mo, rec.weekday, rec.nth)
      if (candidate >= today) return candidate
      mo++
      if (mo > 11) { mo = 0; yr++ }
    }
  }
  return null
}

const fmt = n =>
  `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ─── form defaults ────────────────────────────────────────────────────────────

const EMPTY = {
  book_id:        '',
  account_id:     '',
  description:    '',
  amount:         '',
  type:           'one_time',
  due_date:       '',
  recur_freq:     'monthly_day',
  recur_day:      '1',
  recur_nth:      '1',
  recur_weekday:  '0',
  recur_weekday2: '1',
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function Commitments() {
  const [books,       setBooks]       = useState([])
  const [accounts,    setAccounts]    = useState([])
  const [commitments, setCommitments] = useState([])
  const [form,        setForm]        = useState(EMPTY)
  const [showForm,    setShowForm]    = useState(false)
  const [loading,     setLoading]     = useState(true)

  async function load() {
    setLoading(true)
    const [{ data: bk }, { data: ac }, { data: cm }] = await Promise.all([
      supabase.from('books').select('id, name').order('name'),
      supabase.from('accounts').select('id, name, book_id').order('name'),
      supabase
        .from('commitments')
        .select('*, accounts(name, books(name))')
        .order('description'),
    ])
    setBooks(bk || [])
    setAccounts(ac || [])
    setCommitments(cm || [])
    if (!form.book_id && bk?.length) {
      setForm(f => ({ ...f, book_id: bk[0].id }))
    }
    setLoading(false)
  }

  useEffect(() => { load() }, []) // eslint-disable-line

  const bookAccounts = accounts.filter(a => a.book_id === form.book_id)

  function buildRecurrence() {
    if (form.type !== 'recurring') return null
    if (form.recur_freq === 'monthly_day') {
      return { freq: 'monthly', day: Number(form.recur_day) }
    }
    if (form.recur_freq === 'monthly_nth') {
      return { freq: 'monthly', nth: Number(form.recur_nth), weekday: Number(form.recur_weekday2) }
    }
    if (form.recur_freq === 'weekly') {
      return { freq: 'weekly', weekday: Number(form.recur_weekday) }
    }
    return null
  }

  async function submit(e) {
    e.preventDefault()
    const rec = buildRecurrence()
    const { error } = await supabase.from('commitments').insert({
      book_id:         form.book_id,
      account_id:      form.account_id,
      description:     form.description.trim(),
      amount:          parseFloat(form.amount),
      commitment_type: form.type,
      due_date:        form.type === 'one_time' ? form.due_date : null,
      recurrence:      rec,
    })
    if (error) {
      toast.error(error.message)
    } else {
      toast.success('Commitment added')
      setForm(f => ({ ...EMPTY, book_id: f.book_id }))
      setShowForm(false)
      load()
    }
  }

  async function toggleActive(c) {
    const { error } = await supabase
      .from('commitments')
      .update({ is_active: !c.is_active })
      .eq('id', c.id)
    if (error) toast.error(error.message)
    else load()
  }

  async function del(id) {
    if (!confirm('Delete this commitment?')) return
    const { error } = await supabase.from('commitments').delete().eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Deleted'); load() }
  }

  const previewRec = describeRecurrence(buildRecurrence())

  if (loading) return <Spinner />

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Commitments</h1>
          <p className="text-sm text-gray-500">Scheduled outflows — one-time and recurring</p>
        </div>
        <button
          onClick={() => setShowForm(s => !s)}
          className="btn-primary"
        >
          {showForm ? 'Cancel' : '+ Add Commitment'}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <form onSubmit={submit} className="card p-5 space-y-4">
          <h2 className="font-semibold">New Commitment</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="label">Description *</label>
              <input
                className="input"
                placeholder="e.g. Staff salary, Office rent, SIP"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                required
              />
            </div>

            <div>
              <label className="label">Book *</label>
              <select
                className="input"
                value={form.book_id}
                onChange={e => setForm(f => ({ ...f, book_id: e.target.value, account_id: '' }))}
                required
              >
                <option value="">— Select book —</option>
                {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>

            <div>
              <label className="label">Paid from account *</label>
              <select
                className="input"
                value={form.account_id}
                onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}
                required
              >
                <option value="">— Select account —</option>
                {bookAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>

            <div>
              <label className="label">Amount (₹) *</label>
              <input
                className="input"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                required
              />
            </div>

            <div className="flex flex-col justify-end">
              <label className="label">Type</label>
              <div className="flex gap-4 mt-2">
                {[['one_time', 'One-time'], ['recurring', 'Recurring']].map(([v, l]) => (
                  <label key={v} className="flex items-center gap-1.5 cursor-pointer text-sm">
                    <input
                      type="radio"
                      value={v}
                      checked={form.type === v}
                      onChange={() => setForm(f => ({ ...f, type: v }))}
                      className="accent-brand-600"
                    />
                    {l}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* One-time: due date */}
          {form.type === 'one_time' && (
            <div className="w-48">
              <label className="label">Due date *</label>
              <input
                className="input"
                type="date"
                value={form.due_date}
                onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
                required
              />
            </div>
          )}

          {/* Recurring builder */}
          {form.type === 'recurring' && (
            <div className="p-4 bg-gray-50 rounded-xl space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Recurrence pattern</p>

              <div>
                <label className="label">Frequency</label>
                <select
                  className="input w-64"
                  value={form.recur_freq}
                  onChange={e => setForm(f => ({ ...f, recur_freq: e.target.value }))}
                >
                  <option value="monthly_day">Monthly — specific day</option>
                  <option value="monthly_nth">Monthly — nth weekday</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>

              {form.recur_freq === 'monthly_day' && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-600">Day</span>
                  <input
                    className="input w-20 text-center"
                    type="number"
                    min="1"
                    max="28"
                    value={form.recur_day}
                    onChange={e => setForm(f => ({ ...f, recur_day: e.target.value }))}
                    required
                  />
                  <span className="text-gray-600">of every month</span>
                </div>
              )}

              {form.recur_freq === 'monthly_nth' && (
                <div className="flex items-center gap-2 text-sm flex-wrap">
                  <select
                    className="input w-24"
                    value={form.recur_nth}
                    onChange={e => setForm(f => ({ ...f, recur_nth: e.target.value }))}
                  >
                    {NTH.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
                  </select>
                  <select
                    className="input w-36"
                    value={form.recur_weekday2}
                    onChange={e => setForm(f => ({ ...f, recur_weekday2: e.target.value }))}
                  >
                    {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                  <span className="text-gray-600">of every month</span>
                </div>
              )}

              {form.recur_freq === 'weekly' && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-600">Every</span>
                  <select
                    className="input w-36"
                    value={form.recur_weekday}
                    onChange={e => setForm(f => ({ ...f, recur_weekday: e.target.value }))}
                  >
                    {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </div>
              )}

              {previewRec && (
                <p className="text-xs font-medium text-brand-600">
                  Preview: {previewRec}
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button type="submit" className="btn-primary">Add Commitment</button>
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
          </div>
        </form>
      )}

      {/* Commitments table */}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-head">Description</th>
              <th className="table-head">Account / Book</th>
              <th className="table-head text-right">Amount</th>
              <th className="table-head">Schedule</th>
              <th className="table-head">Next Due</th>
              <th className="table-head">Status</th>
              <th className="table-head w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {commitments.length === 0 && (
              <tr>
                <td colSpan={7} className="table-cell text-center text-gray-400 py-8">
                  No commitments yet — add your first scheduled payment above.
                </td>
              </tr>
            )}
            {commitments.map(c => {
              const nextDue  = getNextDueDate(c)
              const isOverdue = nextDue && nextDue < new Date()
              return (
                <tr key={c.id} className={`hover:bg-gray-50 ${!c.is_active ? 'opacity-50' : ''}`}>
                  <td className="table-cell font-medium text-sm">{c.description}</td>
                  <td className="table-cell text-sm">
                    <span className="text-gray-700">{c.accounts?.name}</span>
                    <br />
                    <span className="text-xs text-gray-400">{c.accounts?.books?.name}</span>
                  </td>
                  <td className="table-cell text-right text-sm font-medium">{fmt(c.amount)}</td>
                  <td className="table-cell text-sm text-gray-600">
                    {c.commitment_type === 'one_time'
                      ? `One-time`
                      : describeRecurrence(c.recurrence)}
                  </td>
                  <td className="table-cell text-sm">
                    {nextDue ? (
                      <span className={isOverdue ? 'text-red-600 font-medium' : 'text-gray-700'}>
                        {format(nextDue, 'dd MMM yyyy')}
                        {isOverdue && <span className="text-xs ml-1">(past)</span>}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="table-cell">
                    <button
                      onClick={() => toggleActive(c)}
                      className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${
                        c.is_active
                          ? 'bg-green-100 text-green-700 hover:bg-green-200'
                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >
                      {c.is_active ? 'Active' : 'Paused'}
                    </button>
                  </td>
                  <td className="table-cell">
                    <button onClick={() => del(c.id)} className="text-red-400 hover:text-red-600 text-xs">
                      Del
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
