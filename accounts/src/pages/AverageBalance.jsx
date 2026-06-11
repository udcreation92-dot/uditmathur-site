import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { format, eachDayOfInterval, parseISO, differenceInDays, isAfter, isBefore, isToday } from 'date-fns'

// ─── helpers ─────────────────────────────────────────────────────────────────

function normalBalance(type, dr, cr) {
  if (type === 'asset' || type === 'expense') return dr - cr
  return cr - dr
}

const fmt = (n, showSign = false) => {
  const abs = `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
  if (showSign && n < 0) return `−${abs}`
  return abs
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function AverageBalance() {
  const [searchParams] = useSearchParams()
  const [books,     setBooks]     = useState([])
  const [accounts,  setAccounts]  = useState([])
  const [selBook,   setSelBook]   = useState(searchParams.get('book')    || '')
  const [selAcc,    setSelAcc]    = useState(searchParams.get('account') || '')
  const [fromDate,  setFromDate]  = useState('')
  const [toDate,    setToDate]    = useState('')
  const [target,    setTarget]    = useState('')
  const [result,    setResult]    = useState(null)
  const [loading,   setLoading]   = useState(false)

  useEffect(() => {
    // Pre-fill "this month" dates
    const periods = quickPeriods()
    const thisMonth = periods[0]
    setFromDate(thisMonth.from)
    setToDate(thisMonth.to)

    async function load() {
      const [{ data: bk }, { data: ac }] = await Promise.all([
        supabase.from('books').select('id, name').order('name'),
        supabase.from('accounts').select('id, name, type, book_id').order('name'),
      ])
      setBooks(bk || [])
      setAccounts(ac || [])
      // Only set default book if not pre-selected via URL param
      if (bk?.length && !searchParams.get('book')) setSelBook(bk[0].id)
    }
    load()
  }, [])  // eslint-disable-line

  const bookAccounts = accounts.filter(a => a.book_id === selBook)
  const selAccObj    = accounts.find(a => a.id === selAcc)

  async function calculate() {
    if (!selAcc || !fromDate || !toDate) return
    setLoading(true)
    setResult(null)

    const today = new Date(); today.setHours(0, 0, 0, 0)
    const start = parseISO(fromDate)
    const end   = parseISO(toDate)

    // ── 1. Opening balance: all lines before the period start ────────────────
    const { data: priorLines } = await supabase
      .from('journal_lines')
      .select('debit, credit, journal_entries!inner(date, book_id)')
      .eq('account_id', selAcc)
      .eq('journal_entries.book_id', selBook)
      .lt('journal_entries.date', fromDate)

    const openingDr = (priorLines || []).reduce((s, l) => s + (l.debit  || 0), 0)
    const openingCr = (priorLines || []).reduce((s, l) => s + (l.credit || 0), 0)
    const openingBal = normalBalance(selAccObj.type, openingDr, openingCr)

    // ── 2. All lines within the period ───────────────────────────────────────
    const { data: periodLines } = await supabase
      .from('journal_lines')
      .select('debit, credit, journal_entries!inner(date, book_id)')
      .eq('account_id', selAcc)
      .eq('journal_entries.book_id', selBook)
      .gte('journal_entries.date', fromDate)
      .lte('journal_entries.date', toDate)

    // Group movements by date
    const movByDate = {}
    for (const l of periodLines || []) {
      const d = l.journal_entries.date
      if (!movByDate[d]) movByDate[d] = { dr: 0, cr: 0 }
      movByDate[d].dr += l.debit  || 0
      movByDate[d].cr += l.credit || 0
    }

    // ── 3. Build day-by-day balance array ────────────────────────────────────
    const allDays   = eachDayOfInterval({ start, end })
    const dayRows   = []
    let runningBal  = openingBal

    for (const day of allDays) {
      const key = format(day, 'yyyy-MM-dd')
      const mov = movByDate[key]
      if (mov) {
        runningBal += normalBalance(selAccObj.type, mov.dr, mov.cr)
      }
      const isPast   = isBefore(day, today)
      const isFuture = !isBefore(day, today)
      dayRows.push({ date: day, key, balance: runningBal, isPast, isFuture, hasTxn: !!mov })
    }

    // ── 4. AMB calculations ──────────────────────────────────────────────────
    const totalDays    = allDays.length
    const elapsedRows  = dayRows.filter(r => r.isPast)
    const elapsedDays  = elapsedRows.length
    const remainDays   = totalDays - elapsedDays

    const elapsedSum   = elapsedRows.reduce((s, r) => s + r.balance, 0)
    const currentAMB   = elapsedDays > 0 ? elapsedSum / elapsedDays : 0

    // Today's balance (today is a remaining day — still changing)
    const todayRow   = dayRows.find(r => isToday(r.date))
    const currentBal = todayRow?.balance ?? elapsedRows[elapsedRows.length - 1]?.balance ?? 0

    // Required balance to hit target
    let requiredBal    = null
    let targetMet      = false
    if (target && parseFloat(target) > 0 && remainDays > 0) {
      const T  = parseFloat(target)
      const req = (T * totalDays - elapsedSum) / remainDays
      requiredBal = req
      targetMet   = req <= currentBal
    } else if (target && parseFloat(target) > 0 && remainDays === 0) {
      targetMet = currentAMB >= parseFloat(target)
    }

    // Projected AMB if current balance held for remaining days (today + future)
    const projectedAMB = totalDays > 0
      ? (elapsedSum + currentBal * remainDays) / totalDays
      : currentAMB

    setResult({
      dayRows, totalDays, elapsedDays, remainDays,
      elapsedSum, currentAMB, projectedAMB,
      requiredBal, targetMet, openingBal,
      currentBal,
    })
    setLoading(false)
  }

  return (
    <div className="max-w-4xl space-y-5">
      <h1 className="text-2xl font-bold">Average Balance Tracker</h1>
      <p className="text-sm text-gray-500">
        Calculate the average daily balance of an account over any period, and find out what balance
        you need to maintain to hit a target monthly average.
      </p>

      {/* Inputs */}
      <div className="card p-5 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <label className="label">Book</label>
            <select className="input" value={selBook}
              onChange={e => { setSelBook(e.target.value); setSelAcc('') }}>
              {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Account</label>
            <select className="input" value={selAcc} onChange={e => setSelAcc(e.target.value)} required>
              <option value="">— Select account —</option>
              {bookAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Target AMB (optional)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
              <input className="input pl-6" type="number" min="0" step="0.01"
                placeholder="e.g. 10000"
                value={target} onChange={e => setTarget(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">From date</label>
            <input className="input" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div>
            <label className="label">To date</label>
            <input className="input" type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <div className="flex items-end">
            <button
              onClick={calculate}
              disabled={loading || !selAcc || !fromDate || !toDate}
              className="btn-primary w-full justify-center">
              {loading ? 'Calculating…' : 'Calculate'}
            </button>
          </div>
        </div>

        {/* Quick period buttons */}
        <div className="flex gap-2 flex-wrap">
          <span className="text-xs text-gray-400 self-center">Quick:</span>
          {quickPeriods().map(p => (
            <button key={p.label} type="button"
              onClick={() => { setFromDate(p.from); setToDate(p.to) }}
              className="text-xs px-3 py-1 rounded-full border border-gray-200 hover:border-brand-400 hover:text-brand-600 transition-colors">
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-4">

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryCard
              label="Average Balance So Far"
              value={fmt(result.currentAMB)}
              sub={`Over ${result.elapsedDays} day${result.elapsedDays !== 1 ? 's' : ''}`}
              color="blue"
            />
            <SummaryCard
              label="Projected Month-End AMB"
              value={fmt(result.projectedAMB)}
              sub={`If ₹${result.currentBal.toLocaleString('en-IN', {maximumFractionDigits:0})} held for ${result.remainDays}d`}
              color="gray"
            />
            <SummaryCard
              label="Days Remaining"
              value={result.remainDays}
              sub={`of ${result.totalDays} total days`}
              color="gray"
            />
            <SummaryCard
              label="Current Balance"
              value={fmt(result.currentBal)}
              sub="As of today"
              color={result.currentBal >= 0 ? 'green' : 'red'}
            />
          </div>

          {/* Target banner */}
          {target && parseFloat(target) > 0 && (
            <div className={`card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-l-4 ${
              result.targetMet ? 'border-l-green-400 bg-green-50' : 'border-l-amber-400 bg-amber-50'
            }`}>
              <div>
                <p className="font-semibold text-gray-800">
                  {result.targetMet ? '✓ Target achievable at current balance' : '⚠ Balance adjustment needed'}
                </p>
                <p className="text-sm text-gray-500 mt-0.5">
                  Target AMB: <strong>{fmt(parseFloat(target))}</strong>
                  {result.remainDays === 0 && (
                    <span className="ml-2">{result.targetMet ? '— Target met ✓' : '— Target missed ✗'}</span>
                  )}
                </p>
              </div>
              {result.requiredBal !== null && result.remainDays > 0 && (
                <div className="text-center sm:text-right">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Required balance</p>
                  <p className={`text-2xl font-bold ${result.requiredBal < 0 ? 'text-green-600' : 'text-gray-800'}`}>
                    {result.requiredBal < 0
                      ? 'Target already met!'
                      : fmt(result.requiredBal)}
                  </p>
                  <p className="text-xs text-gray-400">
                    maintain for remaining {result.remainDays} day{result.remainDays !== 1 ? 's' : ''}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Day-by-day table */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <h2 className="font-semibold text-sm">Day-by-Day Balance</h2>
              <span className="text-xs text-gray-400">{result.totalDays} days</span>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0">
                  <tr>
                    <th className="table-head">Date</th>
                    <th className="table-head">Day</th>
                    <th className="table-head text-right">Closing Balance</th>
                    <th className="table-head text-right">Running AMB</th>
                    <th className="table-head w-6"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {result.dayRows.map((row, i) => {
                    const runningAMB = result.dayRows.slice(0, i + 1)
                      .reduce((s, r) => s + r.balance, 0) / (i + 1)
                    const isToday_ = isToday(row.date)
                    return (
                      <tr key={row.key}
                        className={`${isToday_ ? 'bg-brand-50 font-semibold' : row.isFuture ? 'opacity-40' : 'hover:bg-gray-50'}`}>
                        <td className="table-cell text-sm whitespace-nowrap">
                          {format(row.date, 'dd MMM yyyy')}
                          {isToday_ && <span className="ml-1 text-xs text-brand-600">(today)</span>}
                        </td>
                        <td className="table-cell text-xs text-gray-400">
                          {format(row.date, 'EEE')}
                        </td>
                        <td className="table-cell text-right font-medium text-sm">
                          <span className={row.balance < 0 ? 'text-red-600' : ''}>
                            {fmt(row.balance, true)}
                          </span>
                          {row.hasTxn && (
                            <span className="ml-1 text-xs text-brand-400">●</span>
                          )}
                        </td>
                        <td className="table-cell text-right text-sm text-gray-500">
                          {row.isPast ? fmt(runningAMB) : '—'}
                        </td>
                        <td className="table-cell">
                          {target && parseFloat(target) > 0 && row.isPast && (
                            runningAMB >= parseFloat(target)
                              ? <span className="text-green-500 text-xs">✓</span>
                              : <span className="text-red-400 text-xs">✗</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot className="border-t-2 border-gray-200 sticky bottom-0 bg-gray-50">
                  <tr>
                    <td colSpan={3} className="table-cell text-right font-bold text-sm">
                      Average Monthly Balance (so far)
                    </td>
                    <td className="table-cell text-right font-bold text-brand-700">
                      {fmt(result.currentAMB)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* How it's calculated */}
          <div className="bg-gray-50 rounded-xl p-4 text-xs text-gray-500 space-y-1">
            <p className="font-semibold text-gray-600">How it's calculated</p>
            <p>AMB = Sum of (daily closing balance × 1 day) ÷ number of days elapsed</p>
            {target && parseFloat(target) > 0 && result.remainDays > 0 && (
              <p>Required balance = (Target × Total days − Sum of past balances) ÷ Remaining days</p>
            )}
            <p className="text-gray-400">● indicates a day with transactions. Future days are dimmed.</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── sub-components ───────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, color }) {
  const colors = {
    blue:  'border-t-brand-500',
    green: 'border-t-green-500',
    red:   'border-t-red-500',
    gray:  'border-t-gray-300',
  }
  return (
    <div className={`card p-4 border-t-4 ${colors[color] || colors.gray}`}>
      <p className="text-xs text-gray-500 font-medium">{label}</p>
      <p className="text-xl font-bold text-gray-800 mt-1">{value}</p>
      <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
    </div>
  )
}

// ─── quick period helpers ─────────────────────────────────────────────────────

function quickPeriods() {
  const now   = new Date()
  const y     = now.getFullYear()
  const m     = now.getMonth()

  const pad   = n => String(n).padStart(2, '0')
  const ymd   = (yr, mo, day) => `${yr}-${pad(mo + 1)}-${pad(day)}`
  const lastDay = (yr, mo) => new Date(yr, mo + 1, 0).getDate()

  return [
    {
      label: 'This month',
      from:  ymd(y, m, 1),
      to:    ymd(y, m, lastDay(y, m)),
    },
    {
      label: 'Last month',
      from:  ymd(y, m - 1 < 0 ? y - 1 : y, m - 1 < 0 ? 11 : m - 1, 1),
      to:    ymd(y, m - 1 < 0 ? y - 1 : y, m - 1 < 0 ? 11 : m - 1, lastDay(y, m - 1 < 0 ? y - 1 : y, m - 1 < 0 ? 11 : m - 1)),
    },
    {
      label: 'Last 30 days',
      from:  ymd(y, m, now.getDate() - 29),
      to:    ymd(y, m, now.getDate()),
    },
    {
      label: 'Last 90 days',
      from:  (() => { const d = new Date(now); d.setDate(d.getDate() - 89); return d.toISOString().split('T')[0] })(),
      to:    now.toISOString().split('T')[0],
    },
  ]
}
