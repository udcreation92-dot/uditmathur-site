import React, { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, parseISO, isAfter, isBefore, isToday } from 'date-fns'

// ─── localStorage helpers ─────────────────────────────────────────────────────
const LS_KEY = 'dashboard_watched_accounts'
function loadWatched() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}
function saveWatched(arr) {
  localStorage.setItem(LS_KEY, JSON.stringify(arr))
}

// ─── AMB calculation (same logic as AverageBalance page) ─────────────────────
function normalBalance(type, dr, cr) {
  if (type === 'asset' || type === 'expense') return dr - cr
  return cr - dr
}

async function calcAMB(bookId, accountId, accType) {
  const today     = new Date(); today.setHours(0, 0, 0, 0)
  const monthStart = startOfMonth(today)
  const monthEnd   = endOfMonth(today)
  const fromDate   = format(monthStart, 'yyyy-MM-dd')
  const toDate     = format(monthEnd,   'yyyy-MM-dd')

  // Opening balance before month start
  const { data: prior } = await supabase
    .from('journal_lines')
    .select('debit, credit, journal_entries!inner(date, book_id)')
    .eq('account_id', accountId)
    .eq('journal_entries.book_id', bookId)
    .lt('journal_entries.date', fromDate)

  const openDr = (prior || []).reduce((s, l) => s + (l.debit  || 0), 0)
  const openCr = (prior || []).reduce((s, l) => s + (l.credit || 0), 0)
  const openBal = normalBalance(accType, openDr, openCr)

  // Lines within this month
  const { data: period } = await supabase
    .from('journal_lines')
    .select('debit, credit, journal_entries!inner(date, book_id)')
    .eq('account_id', accountId)
    .eq('journal_entries.book_id', bookId)
    .gte('journal_entries.date', fromDate)
    .lte('journal_entries.date', toDate)

  const movByDate = {}
  for (const l of period || []) {
    const d = l.journal_entries.date
    if (!movByDate[d]) movByDate[d] = { dr: 0, cr: 0 }
    movByDate[d].dr += l.debit  || 0
    movByDate[d].cr += l.credit || 0
  }

  const allDays   = eachDayOfInterval({ start: monthStart, end: monthEnd })
  const totalDays = allDays.length
  let running     = openBal
  let elapsedSum  = 0
  let elapsedDays = 0
  let currentBal  = openBal

  for (const day of allDays) {
    const key = format(day, 'yyyy-MM-dd')
    if (movByDate[key]) {
      running += normalBalance(accType, movByDate[key].dr, movByDate[key].cr)
    }
    const past = isBefore(day, today) || isToday(day)
    if (past) { elapsedSum += running; elapsedDays++; currentBal = running }
  }

  const currentAMB   = elapsedDays > 0 ? elapsedSum / elapsedDays : 0
  const remainDays   = totalDays - elapsedDays
  const projectedAMB = totalDays > 0 ? (elapsedSum + currentBal * remainDays) / totalDays : currentAMB

  return { currentBal, currentAMB, projectedAMB, totalDays, elapsedDays, remainDays, elapsedSum }
}

// ─── main component ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [books,    setBooks]    = useState([])
  const [recent,   setRecent]   = useState([])
  const [recon,    setRecon]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  // Watched accounts
  const [watched,       setWatched]       = useState(loadWatched)
  const [watchedStats,  setWatchedStats]  = useState({})   // keyed by unique id
  const [showAddModal,  setShowAddModal]  = useState(false)
  const [allAccounts,   setAllAccounts]   = useState([])

  useEffect(() => { load() }, [])

  // Refresh AMB stats whenever watched list changes
  useEffect(() => {
    if (watched.length === 0) return
    watched.forEach(w => refreshStat(w))
  }, [watched])  // eslint-disable-line

  async function refreshStat(w) {
    const acc = allAccounts.find(a => a.id === w.accountId) ||
                { type: w.accType || 'asset' }
    const stats = await calcAMB(w.bookId, w.accountId, acc.type || w.accType || 'asset')
    setWatchedStats(prev => ({ ...prev, [w.id]: stats }))
  }

  async function load() {
    setLoading(true); setError(null)
    try {
      const [{ data: bk, error: e1 }, { data: re, error: e2 }, { data: ac }] = await Promise.all([
        supabase.from('books').select('id, name').order('name'),
        supabase.from('journal_entries')
          .select('id, date, narration, reference_no, books(name)')
          .order('date', { ascending: false }).limit(8),
        supabase.from('accounts').select('id, name, type, book_id').order('name'),
      ])
      if (e1) throw e1
      if (e2) throw e2
      setBooks(bk || [])
      setRecent(re || [])
      setAllAccounts(ac || [])

      // Reconciliation (non-critical)
      const { data: links } = await supabase
        .from('inter_ledger_links')
        .select(`id,
          account_a:account_a_id(id, name, book_id, books(name)),
          account_b:account_b_id(id, name, book_id, books(name))`)
        .limit(20)

      if (links?.length) {
        const statuses = await Promise.all(links.map(async link => {
          const [{ data: lA }, { data: lB }] = await Promise.all([
            supabase.from('journal_lines').select('debit, credit').eq('account_id', link.account_a.id),
            supabase.from('journal_lines').select('debit, credit').eq('account_id', link.account_b.id),
          ])
          const balA = (lA || []).reduce((s, r) => s + r.debit - r.credit, 0)
          const balB = (lB || []).reduce((s, r) => s + r.debit - r.credit, 0)
          return { ...link, balA, balB, matched: Math.abs(balA + balB) < 0.01 }
        }))
        setRecon(statuses)
      }

      // Refresh watched stats now that we have accounts
      const savedWatched = loadWatched()
      if (savedWatched.length && ac?.length) {
        savedWatched.forEach(w => {
          const a = ac.find(x => x.id === w.accountId)
          if (a) calcAMB(w.bookId, w.accountId, a.type)
            .then(stats => setWatchedStats(prev => ({ ...prev, [w.id]: stats })))
        })
      }
    } catch (err) {
      console.error('Dashboard load error:', err)
      setError(err.message || 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }

  function addWatched(entry) {
    const updated = [...watched, entry]
    setWatched(updated)
    saveWatched(updated)
  }

  function removeWatched(id) {
    const updated = watched.filter(w => w.id !== id)
    setWatched(updated)
    saveWatched(updated)
    setWatchedStats(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  function updateTarget(id, target) {
    const updated = watched.map(w => w.id === id ? { ...w, target: parseFloat(target) || 0 } : w)
    setWatched(updated)
    saveWatched(updated)
  }

  if (loading) return <Spinner />
  if (error) return (
    <div className="p-6 text-center space-y-3">
      <p className="text-red-600 font-medium">Failed to load: {error}</p>
      <button onClick={load} className="btn-primary">Retry</button>
    </div>
  )

  const mismatched = recon.filter(r => !r.matched)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link to="/entry/new" className="btn-primary">+ New Entry</Link>
      </div>

      {/* ── Reconciliation alert ── */}
      {mismatched.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="font-semibold text-red-700 mb-2">
            ⚠️ {mismatched.length} reconciliation mismatch{mismatched.length > 1 ? 'es' : ''}
          </p>
          {mismatched.map(r => (
            <p key={r.id} className="text-sm text-red-600">
              {r.account_a.books.name} › {r.account_a.name} vs {r.account_b.books.name} › {r.account_b.name}
              {' '}— Diff: <strong>₹{Math.abs(r.balA + r.balB).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
            </p>
          ))}
          <Link to="/reconciliation" className="text-sm text-red-700 underline mt-2 inline-block">
            View full reconciliation →
          </Link>
        </div>
      )}

      {/* ── Watched Accounts ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-semibold text-gray-700">Watched Accounts</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Current balance · this month's AMB · required to maintain
            </p>
          </div>
          <button onClick={() => setShowAddModal(true)} className="btn-secondary text-xs px-3 py-1.5">
            + Watch Account
          </button>
        </div>

        {watched.length === 0 ? (
          <div className="card border-dashed p-6 text-center text-gray-400 text-sm">
            <p className="text-2xl mb-2">📌</p>
            <p>No accounts watched yet.</p>
            <p>Click <strong>+ Watch Account</strong> to track an account's balance & AMB here.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {watched.map(w => {
              const acc   = allAccounts.find(a => a.id === w.accountId)
              const book  = books.find(b => b.id === w.bookId)
              const stats = watchedStats[w.id]

              let requiredBal = null
              if (stats && w.target > 0 && stats.remainDays > 0) {
                requiredBal = (w.target * stats.totalDays - stats.elapsedSum) / stats.remainDays
              }
              const targetMet = stats && w.target > 0 && (
                requiredBal !== null ? requiredBal <= stats.currentBal : stats.currentAMB >= w.target
              )

              return (
                <WatchedCard
                  key={w.id}
                  w={w} acc={acc} book={book} stats={stats}
                  requiredBal={requiredBal} targetMet={targetMet}
                  onRemove={() => removeWatched(w.id)}
                  onTargetChange={val => updateTarget(w.id, val)}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* ── Books ── */}
      <div>
        <h2 className="font-semibold text-gray-700 mb-2">Books</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {books.map(b => (
            <Link key={b.id} to={`/ledger?book=${b.id}`}
              className="card p-4 hover:border-brand-400 transition-colors">
              <p className="font-medium text-sm">{b.name}</p>
              <p className="text-xs text-gray-400 mt-0.5">View ledger →</p>
            </Link>
          ))}
          <Link to="/books"
            className="card p-4 border-dashed hover:border-brand-400 transition-colors flex items-center justify-center text-gray-400 text-sm">
            + Add book
          </Link>
        </div>
      </div>

      {/* ── Recent entries ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-gray-700">Recent Entries</h2>
          <Link to="/ledger" className="text-sm text-brand-600 hover:underline">View all</Link>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[360px]">
            <thead>
              <tr>
                <th className="table-head">Date</th>
                <th className="table-head">Book</th>
                <th className="table-head">Narration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recent.length === 0 && (
                <tr><td colSpan={3} className="table-cell text-center text-gray-400 py-6">No entries yet</td></tr>
              )}
              {recent.map(e => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="table-cell whitespace-nowrap text-sm">{format(new Date(e.date), 'dd MMM yy')}</td>
                  <td className="table-cell text-xs text-gray-500 whitespace-nowrap">{e.books?.name}</td>
                  <td className="table-cell text-sm truncate max-w-[160px]">{e.narration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add Watched Modal ── */}
      {showAddModal && (
        <AddWatchModal
          books={books}
          allAccounts={allAccounts}
          existing={watched}
          onAdd={addWatched}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  )
}

// ─── Watched Account Card ─────────────────────────────────────────────────────
function WatchedCard({ w, acc, book, stats, requiredBal, targetMet, onRemove, onTargetChange }) {
  const [editTarget, setEditTarget] = useState(false)
  const [tmpTarget,  setTmpTarget]  = useState(String(w.target || ''))

  const fmt = n => `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

  const balColor = !stats ? 'text-gray-400' :
    stats.currentBal < 0 ? 'text-red-600' : 'text-gray-900'

  return (
    <div className="card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm truncate">{acc?.name || w.accountName}</p>
          <p className="text-xs text-gray-400 truncate">{book?.name || '—'}</p>
        </div>
        <button onClick={onRemove} className="text-gray-300 hover:text-red-400 text-lg leading-none flex-shrink-0">×</button>
      </div>

      {/* Balance row */}
      <div className="flex items-baseline gap-3 flex-wrap">
        <div>
          <p className="text-xs text-gray-400">Balance</p>
          <p className={`text-xl font-bold ${balColor}`}>
            {stats ? fmt(stats.currentBal) : <span className="text-sm animate-pulse">Loading…</span>}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Month AMB</p>
          <p className="text-lg font-semibold text-gray-700">
            {stats ? fmt(stats.currentAMB) : '—'}
          </p>
        </div>
        {stats && (
          <div>
            <p className="text-xs text-gray-400">Projected</p>
            <p className="text-sm font-medium text-gray-500">{fmt(stats.projectedAMB)}</p>
          </div>
        )}
      </div>

      {/* Target + Required */}
      <div className={`rounded-lg p-2.5 ${
        !w.target ? 'bg-gray-50' :
        targetMet  ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'
      }`}>
        {editTarget ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Target AMB ₹</span>
            <input
              autoFocus
              type="number" min="0" step="0.01"
              value={tmpTarget}
              onChange={e => setTmpTarget(e.target.value)}
              className="w-28 text-sm border border-gray-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <button
              onClick={() => { onTargetChange(tmpTarget); setEditTarget(false) }}
              className="text-xs bg-brand-600 text-white px-2 py-0.5 rounded">
              Save
            </button>
            <button onClick={() => setEditTarget(false)} className="text-xs text-gray-400">Cancel</button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              {w.target > 0 ? (
                <>
                  <p className="text-xs text-gray-500">
                    Target: <strong>{fmt(w.target)}</strong>
                    {' · '}
                    {stats?.remainDays != null ? `${stats.remainDays}d left` : ''}
                  </p>
                  {stats && requiredBal !== null && stats.remainDays > 0 && (
                    <p className={`text-sm font-semibold mt-0.5 ${targetMet ? 'text-green-700' : 'text-amber-700'}`}>
                      {requiredBal <= 0
                        ? '✓ Target already met!'
                        : `Maintain ${fmt(requiredBal)} for ${stats.remainDays}d`}
                    </p>
                  )}
                  {stats?.remainDays === 0 && (
                    <p className={`text-sm font-semibold mt-0.5 ${targetMet ? 'text-green-700' : 'text-red-600'}`}>
                      {targetMet ? '✓ Target met this month!' : '✗ Target missed this month'}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-gray-400">No target set</p>
              )}
            </div>
            <button
              onClick={() => { setTmpTarget(String(w.target || '')); setEditTarget(true) }}
              className="text-xs text-brand-600 hover:underline flex-shrink-0">
              {w.target > 0 ? 'Edit' : 'Set target'}
            </button>
          </div>
        )}
      </div>

      {/* Link to avg balance page */}
      <Link
        to={`/avg-balance?book=${w.bookId}&account=${w.accountId}`}
        className="text-xs text-brand-600 hover:underline">
        Full analysis →
      </Link>
    </div>
  )
}

// ─── Add Watch Modal ──────────────────────────────────────────────────────────
function AddWatchModal({ books, allAccounts, existing, onAdd, onClose }) {
  const [selBook,   setSelBook]   = useState(books[0]?.id || '')
  const [selAcc,    setSelAcc]    = useState('')
  const [target,    setTarget]    = useState('')

  const bookAccounts = allAccounts.filter(a => a.book_id === selBook)
  const existingIds  = new Set(existing.map(w => w.accountId + w.bookId))

  function handleAdd() {
    if (!selAcc) return
    const acc = allAccounts.find(a => a.id === selAcc)
    const id  = Date.now().toString(36) + Math.random().toString(36).slice(2)
    onAdd({
      id,
      bookId:      selBook,
      accountId:   selAcc,
      accountName: acc?.name || '',
      accType:     acc?.type || 'asset',
      target:      parseFloat(target) || 0,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-lg">Watch an Account</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Book</label>
            <select className="input" value={selBook}
              onChange={e => { setSelBook(e.target.value); setSelAcc('') }}>
              {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          <div>
            <label className="label">Account</label>
            <select className="input" value={selAcc} onChange={e => setSelAcc(e.target.value)}>
              <option value="">— Select account —</option>
              {bookAccounts.map(a => {
                const alreadyAdded = existingIds.has(a.id + selBook)
                return (
                  <option key={a.id} value={a.id} disabled={alreadyAdded}>
                    {a.name} ({a.type}){alreadyAdded ? ' — already watched' : ''}
                  </option>
                )
              })}
            </select>
          </div>

          <div>
            <label className="label">
              Target Monthly Average Balance
              <span className="ml-1 text-gray-400 font-normal text-xs">(optional)</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
              <input
                className="input pl-6"
                type="number" min="0" step="0.01"
                placeholder="e.g. 10000"
                value={target}
                onChange={e => setTarget(e.target.value)}
              />
            </div>
            <p className="text-xs text-gray-400 mt-1">
              The dashboard will show what balance you need to keep for the rest of the month to hit this target.
            </p>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleAdd} disabled={!selAcc}>
            Add to Dashboard
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── spinner ──────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
