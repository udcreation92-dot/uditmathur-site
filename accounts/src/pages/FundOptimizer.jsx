import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { format, addDays, parseISO } from 'date-fns'

// ─── helpers ─────────────────────────────────────────────────────────────────

function normalBalance(type, dr, cr) {
  if (type === 'asset' || type === 'expense') return dr - cr
  return cr - dr
}

const fmt = n =>
  `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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

// Returns the single next occurrence of the commitment on or after `from`, up to `to`
function getNextOccurrence(commitment, from, to) {
  if (commitment.commitment_type === 'one_time') {
    const d = parseISO(commitment.due_date)
    return d >= from && d <= to ? d : null
  }
  const rec = commitment.recurrence
  if (!rec) return null

  if (rec.freq === 'weekly') {
    const diff = (rec.weekday - from.getDay() + 7) % 7
    const candidate = addDays(from, diff)
    return candidate <= to ? candidate : null
  }
  if (rec.freq === 'monthly' && rec.day !== undefined) {
    let candidate = new Date(from.getFullYear(), from.getMonth(), rec.day)
    if (candidate < from) candidate = new Date(from.getFullYear(), from.getMonth() + 1, rec.day)
    return candidate <= to ? candidate : null
  }
  if (rec.freq === 'monthly' && rec.nth !== undefined) {
    let yr = from.getFullYear()
    let mo = from.getMonth()
    for (let i = 0; i < 24; i++) {
      const candidate = getNthWeekdayOfMonth(yr, mo, rec.weekday, rec.nth)
      if (candidate > to) break
      if (candidate >= from) return candidate
      mo++
      if (mo > 11) { mo = 0; yr++ }
    }
  }
  return null
}

// Compute the AMB lock-in: minimum balance to hold for the rest of the current
// month so the running average still meets ambTarget.
// Returns the static ambTarget as a fallback when no history is available.
function calcAmbLockin(accountType, ambTarget, priorDr, priorCr, monthMovements) {
  if (!ambTarget || ambTarget <= 0) return 0
  const now      = new Date(); now.setHours(0, 0, 0, 0)
  const year     = now.getFullYear()
  const month    = now.getMonth()
  const totalDays = new Date(year, month + 1, 0).getDate()
  const todayDate = now.getDate()

  // Reconstruct daily closing balances from month start to today
  let running = normalBalance(accountType, priorDr || 0, priorCr || 0)
  let elapsedSum = 0
  for (let d = 1; d <= todayDate; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const mov = monthMovements?.[key]
    if (mov) running += normalBalance(accountType, mov.dr, mov.cr)
    elapsedSum += running
  }

  const remainDays = totalDays - todayDate
  if (remainDays <= 0) return 0 // last day of month — nothing left to lock
  return Math.max(0, (ambTarget * totalDays - elapsedSum) / remainDays)
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function FundOptimizer() {
  const [accounts,    setAccounts]    = useState([])
  const [settingsMap, setSettingsMap] = useState({})
  const [commitments, setCommitments] = useState([])
  const [balances,    setBalances]    = useState({})
  const [ambData,     setAmbData]     = useState({}) // per-account month history for AMB lock-in
  const [horizon,     setHorizon]     = useState(30)
  const [loading,     setLoading]     = useState(true)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const today = format(new Date(), 'yyyy-MM-dd')
    const now   = new Date()
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

    const [{ data: acctData }, { data: settingsData }, { data: commitData }] = await Promise.all([
      supabase.from('accounts').select('*, books(name)').order('name'),
      supabase.from('account_settings').select('*'),
      supabase
        .from('commitments')
        .select('*, accounts(name, type, book_id, books(name))')
        .eq('is_active', true),
    ])

    const accts = acctData || []
    const sMap  = Object.fromEntries((settingsData || []).map(s => [s.account_id, s]))
    setAccounts(accts)
    setSettingsMap(sMap)
    setCommitments(commitData || [])

    // Fetch balances for all accounts that have a meaningful role
    const ids = accts
      .filter(a => sMap[a.id]?.account_role && sMap[a.id].account_role !== 'other')
      .map(a => a.id)

    if (ids.length > 0) {
      const { data: lines } = await supabase
        .from('journal_lines')
        .select('account_id, debit, credit, journal_entries!inner(date)')
        .in('account_id', ids)
        .lte('journal_entries.date', today)

      const balMap        = {}
      const priorMonthMap = {} // lines before this month → opening balance
      const monthLinesMap = {} // lines this month by date → for AMB daily walk

      for (const l of lines || []) {
        const aid  = l.account_id
        const date = l.journal_entries.date

        if (!balMap[aid]) balMap[aid] = { dr: 0, cr: 0 }
        balMap[aid].dr += l.debit  || 0
        balMap[aid].cr += l.credit || 0

        if (date < monthStart) {
          if (!priorMonthMap[aid]) priorMonthMap[aid] = { dr: 0, cr: 0 }
          priorMonthMap[aid].dr += l.debit  || 0
          priorMonthMap[aid].cr += l.credit || 0
        } else {
          if (!monthLinesMap[aid])        monthLinesMap[aid] = {}
          if (!monthLinesMap[aid][date])  monthLinesMap[aid][date] = { dr: 0, cr: 0 }
          monthLinesMap[aid][date].dr += l.debit  || 0
          monthLinesMap[aid][date].cr += l.credit || 0
        }
      }

      const computed = {}
      const ambMap   = {}
      for (const a of accts) {
        const { dr = 0, cr = 0 } = balMap[a.id] || {}
        computed[a.id] = normalBalance(a.type, dr, cr)
        ambMap[a.id]   = {
          priorDr:    priorMonthMap[a.id]?.dr || 0,
          priorCr:    priorMonthMap[a.id]?.cr || 0,
          monthLines: monthLinesMap[a.id]     || {},
        }
      }
      setBalances(computed)
      setAmbData(ambMap)
    }

    setLoading(false)
  }

  // ── derived analysis ────────────────────────────────────────────────────────
  const today      = new Date(); today.setHours(0, 0, 0, 0)
  const horizonEnd = addDays(today, horizon)

  // Next single outflow per commitment within horizon
  const outflows = {}
  for (const c of commitments) {
    const next = getNextOccurrence(c, today, horizonEnd)
    if (next) {
      outflows[c.account_id] = (outflows[c.account_id] || 0) + Number(c.amount)
    }
  }

  const byRole = role => accounts.filter(a => settingsMap[a.id]?.account_role === role)

  const bankAccounts = accounts.filter(a => {
    const r = settingsMap[a.id]?.account_role
    return r === 'savings' || r === 'current'
  })

  // Per-account analysis
  const analysis = bankAccounts.map(a => {
    const s         = settingsMap[a.id] || {}
    const balance   = balances[a.id] ?? 0
    const ambTarget = Number(s.min_balance || 0)
    const upcoming  = outflows[a.id] || 0
    const ad        = ambData[a.id]
    // Dynamic lock-in: balance needed for remaining days to hit AMB target
    const ambLockin = ad
      ? calcAmbLockin(a.type, ambTarget, ad.priorDr, ad.priorCr, ad.monthLines)
      : ambTarget
    const excess    = balance - ambLockin - upcoming
    return { ...a, balance, ambTarget, ambLockin, upcoming, excess, rate: Number(s.interest_rate_pa || 0) }
  })

  // Best placement account (highest interest rate among savings/current)
  const bestAccount = analysis.length
    ? [...analysis].sort((a, b) => b.rate - a.rate)[0]
    : null

  const totalExcess = analysis.reduce((s, a) => s + Math.max(0, a.excess), 0)

  // Credit cards
  const creditCards       = byRole('credit_card')
  const ccOutstanding     = creditCards.reduce((s, a) => s + Math.max(0, balances[a.id] ?? 0), 0)

  // Net investable
  const netInvestable = Math.max(0, totalExcess - ccOutstanding)

  // Transfers to recommend
  const transfers = analysis.filter(a => a.excess > 0 && bestAccount && a.id !== bestAccount.id)

  // Investment / trading accounts
  const deployedAccounts = [
    ...byRole('investment'),
    ...byRole('trading'),
  ]

  const unconfigured = accounts.filter(
    a => !settingsMap[a.id] || settingsMap[a.id].account_role === 'other'
  )

  // Commitments firing in the horizon
  const upcomingCommitments = commitments.filter(c => getNextOccurrence(c, today, horizonEnd))

  if (loading) return <Spinner />

  return (
    <div className="max-w-5xl space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Fund Optimizer</h1>
          <p className="text-sm text-gray-500">Liquidity analysis across all your bank accounts</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 whitespace-nowrap">Look ahead:</label>
          <select value={horizon} onChange={e => setHorizon(Number(e.target.value))} className="input w-32">
            <option value={15}>15 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
          <button onClick={loadAll} className="btn-secondary text-sm">Refresh</button>
        </div>
      </div>

      {/* Setup nudge */}
      {unconfigured.length > 0 && (
        <div className="card p-4 border-l-4 border-l-amber-400 bg-amber-50">
          <p className="text-sm font-medium text-amber-800">
            {unconfigured.length} account{unconfigured.length > 1 ? 's have' : ' has'} no role
            configured —{' '}
            <Link to="/accounts" className="underline">Chart of Accounts</Link>
            {' '}→ click ⚙ on each account to set role, interest rate, and minimum balance.
          </p>
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard
          label="Total Excess"
          value={fmt(totalExcess)}
          sub={`${analysis.filter(a => a.excess > 0).length} of ${analysis.length} accounts`}
          color="green"
        />
        <SummaryCard
          label="CC Outstanding"
          value={fmt(ccOutstanding)}
          sub={`${creditCards.length} credit card${creditCards.length !== 1 ? 's' : ''}`}
          color="red"
        />
        <SummaryCard
          label="Net Investable"
          value={fmt(netInvestable)}
          sub="Excess minus CC dues"
          color={netInvestable > 0 ? 'blue' : 'gray'}
        />
        <SummaryCard
          label="Best Rate"
          value={bestAccount ? `${bestAccount.rate.toFixed(2)}% p.a.` : '—'}
          sub={bestAccount ? `${bestAccount.name} (${bestAccount.books?.name})` : 'No accounts configured'}
          color="gray"
        />
      </div>

      {/* Bank accounts breakdown */}
      {analysis.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <h2 className="font-semibold text-sm">Bank Account Breakdown</h2>
            <span className="text-xs text-gray-400">Horizon: next {horizon} days · next occurrence per commitment</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head">Account</th>
                  <th className="table-head">Book</th>
                  <th className="table-head text-right">Balance</th>
                  <th className="table-head text-right">AMB Lock-in</th>
                  <th className="table-head text-right">Next Outflow</th>
                  <th className="table-head text-right">Excess</th>
                  <th className="table-head text-right">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {analysis.map(a => (
                  <tr key={a.id} className={bestAccount?.id === a.id ? 'bg-green-50' : 'hover:bg-gray-50'}>
                    <td className="table-cell font-medium text-sm">
                      {a.name}
                      {bestAccount?.id === a.id && (
                        <span className="ml-1.5 text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">
                          Best rate
                        </span>
                      )}
                    </td>
                    <td className="table-cell text-sm text-gray-500">{a.books?.name}</td>
                    <td className="table-cell text-right text-sm font-medium">
                      <span className={a.balance < 0 ? 'text-red-600' : ''}>{fmt(a.balance)}</span>
                    </td>
                    <td className="table-cell text-right text-sm">
                      {a.ambTarget > 0 ? (
                        <div>
                          <span className="font-medium text-gray-700">{fmt(a.ambLockin)}</span>
                          <span className="block text-xs text-gray-400">target {fmt(a.ambTarget)}</span>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="table-cell text-right text-sm text-orange-600">
                      {a.upcoming > 0 ? fmt(a.upcoming) : '—'}
                    </td>
                    <td className="table-cell text-right text-sm font-semibold">
                      <span className={a.excess < 0 ? 'text-red-600' : 'text-green-700'}>
                        {a.excess < 0 ? `−${fmt(a.excess)}` : fmt(a.excess)}
                      </span>
                    </td>
                    <td className="table-cell text-right text-sm text-gray-600">
                      {a.rate > 0 ? `${a.rate.toFixed(2)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 bg-gray-50">
                <tr>
                  <td colSpan={5} className="table-cell text-right text-sm font-bold">Total excess</td>
                  <td className="table-cell text-right font-bold text-green-700">{fmt(totalExcess)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Action plan */}
      {analysis.length > 0 && (
        <div className="card p-5 space-y-5">
          <h2 className="font-semibold text-base">Recommended Action Plan</h2>

          {/* Step 1: Consolidate */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Step 1 — Consolidate excess to highest-rate account
            </p>
            {transfers.length > 0 && bestAccount ? (
              transfers.map(a => (
                <div key={a.id} className="flex items-start sm:items-center gap-2 text-sm bg-blue-50 px-3 py-2 rounded-lg">
                  <span className="text-blue-500 mt-0.5 sm:mt-0">→</span>
                  <span>
                    Transfer <strong>{fmt(a.excess)}</strong> from{' '}
                    <strong>{a.name}</strong> ({a.books?.name}) to{' '}
                    <strong>{bestAccount.name}</strong> ({bestAccount.books?.name})
                  </span>
                  <span className="ml-auto text-xs text-blue-600 whitespace-nowrap">
                    {bestAccount.rate.toFixed(2)}% p.a.
                  </span>
                </div>
              ))
            ) : bestAccount && transfers.length === 0 ? (
              <p className="text-sm text-gray-500 px-3 py-2 bg-gray-50 rounded-lg">
                All excess is already in <strong>{bestAccount.name}</strong> (highest rate).
              </p>
            ) : (
              <p className="text-sm text-gray-400 px-3 py-2 bg-gray-50 rounded-lg">No excess to consolidate.</p>
            )}
          </div>

          {/* Step 2: CC reserve */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Step 2 — Reserve for credit card dues before moving to trading
            </p>
            {ccOutstanding > 0 ? (
              <>
                {creditCards.filter(a => (balances[a.id] ?? 0) > 0).map(a => (
                  <div key={a.id} className="flex items-center gap-2 text-sm bg-red-50 px-3 py-2 rounded-lg">
                    <span className="text-red-500">💳</span>
                    <span>
                      Keep <strong>{fmt(Math.max(0, balances[a.id] ?? 0))}</strong> available for{' '}
                      <strong>{a.name}</strong> ({a.books?.name})
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between text-sm font-semibold px-3 py-2 bg-red-100 rounded-lg">
                  <span>Total CC reserve</span>
                  <span className="text-red-700">{fmt(ccOutstanding)}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-500 px-3 py-2 bg-gray-50 rounded-lg">
                No credit card outstanding — full excess is investable.
              </p>
            )}
          </div>

          {/* Step 3: Investable */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Step 3 — Net available for trading / investment
            </p>
            <div className={`flex items-center justify-between px-4 py-3 rounded-lg border-2 ${
              netInvestable > 0 ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-gray-50'
            }`}>
              <div>
                <p className="font-semibold text-gray-800">Investable surplus</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {fmt(totalExcess)} excess − {fmt(ccOutstanding)} CC reserve
                </p>
              </div>
              <p className={`text-2xl font-bold ${netInvestable > 0 ? 'text-green-700' : 'text-gray-400'}`}>
                {fmt(netInvestable)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Credit card details table */}
      {creditCards.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
            <h2 className="font-semibold text-sm">Credit Card Outstandings</h2>
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Card / Account</th>
                <th className="table-head">Book</th>
                <th className="table-head text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {creditCards.map(a => {
                const bal = balances[a.id] ?? 0
                return (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="table-cell font-medium text-sm">💳 {a.name}</td>
                    <td className="table-cell text-sm text-gray-500">{a.books?.name}</td>
                    <td className="table-cell text-right text-sm font-semibold">
                      <span className={bal > 0 ? 'text-red-600' : 'text-green-600'}>{fmt(bal)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Deployed capital */}
      {deployedAccounts.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
            <h2 className="font-semibold text-sm">Deployed Capital (Trading / Investment)</h2>
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Account</th>
                <th className="table-head">Book</th>
                <th className="table-head">Role</th>
                <th className="table-head text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {deployedAccounts.map(a => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="table-cell font-medium text-sm">{a.name}</td>
                  <td className="table-cell text-sm text-gray-500">{a.books?.name}</td>
                  <td className="table-cell text-sm">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                      {settingsMap[a.id]?.account_role}
                    </span>
                  </td>
                  <td className="table-cell text-right text-sm font-medium">
                    {fmt(balances[a.id] ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Upcoming commitments in horizon */}
      {upcomingCommitments.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <h2 className="font-semibold text-sm">Next Commitments Due (within {horizon} days)</h2>
            <Link to="/commitments" className="text-xs text-brand-600 hover:underline">Manage →</Link>
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Description</th>
                <th className="table-head">Account</th>
                <th className="table-head text-right">Amount</th>
                <th className="table-head">Next Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {upcomingCommitments.map(c => {
                const next = getNextOccurrence(c, today, horizonEnd)
                return (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="table-cell text-sm">{c.description}</td>
                    <td className="table-cell text-sm text-gray-500">
                      {c.accounts?.name}{' '}
                      <span className="text-gray-400 text-xs">({c.accounts?.books?.name})</span>
                    </td>
                    <td className="table-cell text-right text-sm font-medium text-orange-700">
                      {fmt(c.amount)}
                    </td>
                    <td className="table-cell text-sm text-gray-600">
                      {next ? format(next, 'dd MMM yyyy (EEE)') : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {analysis.length === 0 && (
        <div className="card p-8 text-center text-gray-400 space-y-2">
          <p className="text-lg font-medium">No bank accounts configured</p>
          <p className="text-sm">
            Go to{' '}
            <Link to="/accounts" className="text-brand-600 hover:underline">Chart of Accounts</Link>
            {' '}and click ⚙ on each bank account to set its role (savings / current), interest rate,
            and minimum balance requirement.
          </p>
        </div>
      )}
    </div>
  )
}

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

function Spinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
