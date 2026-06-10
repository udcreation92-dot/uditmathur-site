import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// ─── accounting helpers ───────────────────────────────────────────────────────

// Normal balance by type
// asset/expense → debit normal → balance = dr - cr
// liability/equity/income → credit normal → balance = cr - dr
function normalBalance(type, dr, cr) {
  if (type === 'asset' || type === 'expense') return dr - cr
  return cr - dr
}

async function fetchBalances(bookId, asOf) {
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, name, code, type')
    .eq('book_id', bookId)
    .order('name')

  if (!accounts?.length) return []

  // Fetch all lines in one query, join entries for date filter
  let q = supabase
    .from('journal_lines')
    .select('account_id, debit, credit, journal_entries!inner(book_id, date)')
    .eq('journal_entries.book_id', bookId)

  if (asOf) q = q.lte('journal_entries.date', asOf)

  const { data: lines } = await q

  // Aggregate per account
  const map = {}
  for (const l of lines || []) {
    if (!map[l.account_id]) map[l.account_id] = { dr: 0, cr: 0 }
    map[l.account_id].dr += l.debit  || 0
    map[l.account_id].cr += l.credit || 0
  }

  return accounts.map(a => {
    const { dr = 0, cr = 0 } = map[a.id] || {}
    return { ...a, dr, cr, balance: normalBalance(a.type, dr, cr) }
  })
}

const fmt = n =>
  `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

// ─── P&L ─────────────────────────────────────────────────────────────────────

function ProfitLoss({ books }) {
  const [selBook, setSelBook] = useState(books[0]?.id || '')
  const [from,    setFrom]    = useState('')
  const [to,      setTo]      = useState('')
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => { if (selBook) generate() }, [selBook, from, to])

  async function generate() {
    setLoading(true)
    const all = await fetchBalances(selBook, to)

    // Apply from-date: subtract balances before 'from'
    let fromAdjust = {}
    if (from) {
      let q = supabase
        .from('journal_lines')
        .select('account_id, debit, credit, journal_entries!inner(book_id, date)')
        .eq('journal_entries.book_id', selBook)
        .lt('journal_entries.date', from)
      const { data: priorLines } = await q
      for (const l of priorLines || []) {
        if (!fromAdjust[l.account_id]) fromAdjust[l.account_id] = { dr: 0, cr: 0 }
        fromAdjust[l.account_id].dr += l.debit  || 0
        fromAdjust[l.account_id].cr += l.credit || 0
      }
    }

    const adjusted = all.map(a => {
      const adj = fromAdjust[a.id] || { dr: 0, cr: 0 }
      const dr  = a.dr - adj.dr
      const cr  = a.cr - adj.cr
      return { ...a, dr, cr, balance: normalBalance(a.type, dr, cr) }
    })

    setRows(adjusted.filter(a => ['income', 'expense'].includes(a.type)))
    setLoading(false)
  }

  const income   = rows.filter(r => r.type === 'income')
  const expenses = rows.filter(r => r.type === 'expense')
  const totalIncome  = income.reduce((s, r) => s + r.balance, 0)
  const totalExpense = expenses.reduce((s, r) => s + r.balance, 0)
  const netProfit    = totalIncome - totalExpense

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="card p-4 flex gap-4 flex-wrap items-end">
        <div>
          <label className="label">Book</label>
          <select className="input" value={selBook} onChange={e => setSelBook(e.target.value)}>
            {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">From</label>
          <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        {(from || to) && (
          <button className="btn-secondary text-xs py-1" onClick={() => { setFrom(''); setTo('') }}>
            Clear dates
          </button>
        )}
      </div>

      {loading && <LoadingSpinner />}

      {!loading && (
        <div className="grid md:grid-cols-2 gap-5">
          {/* Income */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 bg-green-50 border-b border-green-100">
              <h3 className="font-semibold text-green-800">Income</h3>
            </div>
            <table className="w-full">
              <tbody className="divide-y divide-gray-100">
                {income.length === 0 && (
                  <tr><td className="table-cell text-gray-400 py-4 text-center">No income accounts</td></tr>
                )}
                {income.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="table-cell">{r.name}</td>
                    <td className="table-cell text-right font-medium text-green-700">
                      {r.balance >= 0 ? fmt(r.balance) : <span className="text-red-500">{fmt(r.balance)} (Dr)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-green-200 bg-green-50">
                <tr>
                  <td className="table-cell font-bold text-green-800">Total Income</td>
                  <td className="table-cell text-right font-bold text-green-800">{fmt(totalIncome)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Expenses */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 bg-red-50 border-b border-red-100">
              <h3 className="font-semibold text-red-800">Expenses</h3>
            </div>
            <table className="w-full">
              <tbody className="divide-y divide-gray-100">
                {expenses.length === 0 && (
                  <tr><td className="table-cell text-gray-400 py-4 text-center">No expense accounts</td></tr>
                )}
                {expenses.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="table-cell">{r.name}</td>
                    <td className="table-cell text-right font-medium text-red-700">
                      {r.balance >= 0 ? fmt(r.balance) : <span className="text-gray-500">{fmt(r.balance)} (Cr)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-red-200 bg-red-50">
                <tr>
                  <td className="table-cell font-bold text-red-800">Total Expenses</td>
                  <td className="table-cell text-right font-bold text-red-800">{fmt(totalExpense)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Net Profit / Loss */}
      {!loading && (
        <div className={`card p-5 flex items-center justify-between ${
          netProfit >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
        }`}>
          <div>
            <p className="text-sm font-medium text-gray-600">
              {netProfit >= 0 ? 'Net Profit' : 'Net Loss'}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">Total Income − Total Expenses</p>
          </div>
          <p className={`text-2xl font-bold ${netProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            {netProfit >= 0 ? '' : '− '}{fmt(netProfit)}
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Balance Sheet ────────────────────────────────────────────────────────────

function BalanceSheet({ books }) {
  const [selBook, setSelBook] = useState(books[0]?.id || '')
  const [asOf,    setAsOf]    = useState('')
  const [rows,    setRows]    = useState([])
  const [netPL,   setNetPL]   = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => { if (selBook) generate() }, [selBook, asOf])

  async function generate() {
    setLoading(true)
    const all = await fetchBalances(selBook, asOf)

    // Compute net profit to add to equity side
    const income   = all.filter(a => a.type === 'income').reduce((s, a) => s + a.balance, 0)
    const expenses = all.filter(a => a.type === 'expense').reduce((s, a) => s + a.balance, 0)
    setNetPL(income - expenses)

    setRows(all.filter(a => ['asset', 'liability', 'equity'].includes(a.type)))
    setLoading(false)
  }

  const assets      = rows.filter(r => r.type === 'asset')
  const liabilities = rows.filter(r => r.type === 'liability')
  const equity      = rows.filter(r => r.type === 'equity')

  const totalAssets      = assets.reduce((s, r) => s + r.balance, 0)
  const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0)
  const totalEquity      = equity.reduce((s, r) => s + r.balance, 0)
  const totalLiabEquity  = totalLiabilities + totalEquity + netPL
  const difference       = Math.abs(totalAssets - totalLiabEquity)

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="card p-4 flex gap-4 flex-wrap items-end">
        <div>
          <label className="label">Book</label>
          <select className="input" value={selBook} onChange={e => setSelBook(e.target.value)}>
            {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">As of date</label>
          <input className="input" type="date" value={asOf} onChange={e => setAsOf(e.target.value)} />
        </div>
        {asOf && (
          <button className="btn-secondary text-xs py-1" onClick={() => setAsOf('')}>Clear</button>
        )}
      </div>

      {loading && <LoadingSpinner />}

      {!loading && (
        <div className="grid md:grid-cols-2 gap-5">
          {/* LEFT: Assets */}
          <div className="space-y-3">
            <SectionTable
              title="Assets"
              color="blue"
              rows={assets}
              total={totalAssets}
              totalLabel="Total Assets"
            />
          </div>

          {/* RIGHT: Liabilities + Equity */}
          <div className="space-y-3">
            <SectionTable
              title="Liabilities"
              color="orange"
              rows={liabilities}
              total={totalLiabilities}
              totalLabel="Total Liabilities"
            />
            <SectionTable
              title="Equity"
              color="purple"
              rows={equity}
              total={totalEquity}
              totalLabel="Total Equity"
              extra={
                netPL !== 0
                  ? [{ label: netPL >= 0 ? 'Add: Net Profit' : 'Less: Net Loss', value: netPL, highlight: true }]
                  : []
              }
              grandTotal={totalLiabEquity}
              grandTotalLabel="Total Liabilities + Equity"
            />
          </div>
        </div>
      )}

      {/* Balance check */}
      {!loading && (
        <div className={`card p-4 flex items-center justify-between ${
          difference < 0.01 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
        }`}>
          <div>
            <p className={`font-semibold ${difference < 0.01 ? 'text-green-700' : 'text-red-700'}`}>
              {difference < 0.01 ? '✓ Balance sheet balances' : '✗ Balance sheet does not balance'}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">Assets must equal Liabilities + Equity + Net Profit</p>
          </div>
          {difference >= 0.01 && (
            <p className="text-red-700 font-bold">Difference: {fmt(difference)}</p>
          )}
        </div>
      )}
    </div>
  )
}

function SectionTable({ title, color, rows, total, totalLabel, extra = [], grandTotal, grandTotalLabel }) {
  const colors = {
    blue:   { header: 'bg-blue-50 border-blue-100 text-blue-800',   foot: 'bg-blue-50 border-blue-200 text-blue-800' },
    orange: { header: 'bg-orange-50 border-orange-100 text-orange-800', foot: 'bg-orange-50 border-orange-200 text-orange-800' },
    purple: { header: 'bg-purple-50 border-purple-100 text-purple-800', foot: 'bg-purple-50 border-purple-200 text-purple-800' },
  }
  const c = colors[color]

  return (
    <div className="card overflow-hidden">
      <div className={`px-4 py-3 border-b ${c.header}`}>
        <h3 className="font-semibold">{title}</h3>
      </div>
      <table className="w-full">
        <tbody className="divide-y divide-gray-100">
          {rows.length === 0 && (
            <tr><td className="table-cell text-gray-400 py-4 text-center">No {title.toLowerCase()} accounts</td></tr>
          )}
          {rows.map(r => (
            <tr key={r.id} className="hover:bg-gray-50">
              <td className="table-cell">{r.name}</td>
              <td className="table-cell text-right font-medium">
                {r.balance >= 0
                  ? fmt(r.balance)
                  : <span className="text-red-500 text-xs">{fmt(r.balance)} (negative)</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className={`border-t-2 ${c.foot}`}>
          <tr>
            <td className="table-cell font-bold">{totalLabel}</td>
            <td className="table-cell text-right font-bold">{fmt(total)}</td>
          </tr>
          {extra.map((e, i) => (
            <tr key={i} className="border-t border-dashed border-gray-200">
              <td className={`table-cell text-sm ${e.highlight ? 'italic' : ''}`}>{e.label}</td>
              <td className={`table-cell text-right text-sm font-medium ${e.value >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                {e.value >= 0 ? '' : '− '}{fmt(e.value)}
              </td>
            </tr>
          ))}
          {grandTotal !== undefined && (
            <tr className="border-t-2 border-gray-300">
              <td className="table-cell font-bold">{grandTotalLabel}</td>
              <td className="table-cell text-right font-bold">{fmt(grandTotal)}</td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  )
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-40">
      <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

// ─── Main page with tabs ──────────────────────────────────────────────────────

export default function Reports() {
  const [books,   setBooks]   = useState([])
  const [tab,     setTab]     = useState('pl')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('books').select('id, name').order('name').then(({ data }) => {
      setBooks(data || [])
      setLoading(false)
    })
  }, [])

  if (loading) return <LoadingSpinner />

  if (!books.length) return (
    <div className="text-center py-16 text-gray-400">
      <p className="text-lg">No books yet — create a book first.</p>
    </div>
  )

  return (
    <div className="max-w-5xl space-y-5">
      <h1 className="text-2xl font-bold">Reports</h1>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        {[
          { key: 'pl',  label: '📊 Profit & Loss'  },
          { key: 'bs',  label: '🏦 Balance Sheet'   },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-white shadow text-brand-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'pl' && <ProfitLoss books={books} />}
      {tab === 'bs' && <BalanceSheet books={books} />}
    </div>
  )
}
