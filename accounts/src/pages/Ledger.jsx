import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

export default function Ledger() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [books,    setBooks]    = useState([])
  const [accounts, setAccounts] = useState([])
  const [entries,  setEntries]  = useState([])
  const [loading,  setLoading]  = useState(false)

  const selBook = searchParams.get('book') || ''
  const selAcc  = searchParams.get('account') || ''
  const fromD   = searchParams.get('from') || ''
  const toD     = searchParams.get('to') || ''

  useEffect(() => {
    async function loadMeta() {
      const [{ data: bk }, { data: ac }] = await Promise.all([
        supabase.from('books').select('id, name').order('name'),
        supabase.from('accounts').select('id, name, type, book_id').order('name'),
      ])
      setBooks(bk || [])
      setAccounts(ac || [])
    }
    loadMeta()
  }, [])

  useEffect(() => {
    if (!selBook && !selAcc) { setEntries([]); return }
    loadEntries()
  }, [selBook, selAcc, fromD, toD])

  async function loadEntries() {
    setLoading(true)
    let q = supabase.from('journal_entries')
      .select(`id, date, narration, reference_no,
        journal_lines(id, debit, credit, account_id,
          accounts(id, name, type))`)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })

    if (selBook)  q = q.eq('book_id', selBook)
    if (fromD)    q = q.gte('date', fromD)
    if (toD)      q = q.lte('date', toD)

    const { data, error } = await q
    if (error) toast.error(error.message)

    let rows = data || []
    if (selAcc) {
      rows = rows.filter(e => e.journal_lines.some(l => l.account_id === selAcc))
    }
    setEntries(rows)
    setLoading(false)
  }

  async function deleteEntry(id) {
    if (!confirm('Delete this journal entry? This cannot be undone.')) return
    const { error } = await supabase.from('journal_entries').delete().eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Entry deleted'); loadEntries() }
  }

  const bookAccounts = accounts.filter(a => !selBook || a.book_id === selBook)

  // Running balance for selected account
  let runningBal = 0
  const rows = entries.flatMap(e => {
    const lines = selAcc
      ? e.journal_lines.filter(l => l.account_id === selAcc)
      : e.journal_lines
    return lines.map(l => {
      const contraLines = selAcc
        ? e.journal_lines.filter(cl => cl.account_id !== selAcc)
        : []
      return { entry: e, line: l, contraLines }
    })
  }).reverse()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Ledger</h1>
        <Link to="/entry/new" className="btn-primary">+ New Entry</Link>
      </div>

      {/* Filters */}
      <div className="card p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="label">Book</label>
          <select className="input" value={selBook}
            onChange={e => setSearchParams({ book: e.target.value, account: '', from: fromD, to: toD })}>
            <option value="">All books</option>
            {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Account</label>
          <select className="input" value={selAcc}
            onChange={e => setSearchParams({ book: selBook, account: e.target.value, from: fromD, to: toD })}>
            <option value="">All accounts</option>
            {bookAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">From</label>
          <input className="input" type="date" value={fromD}
            onChange={e => setSearchParams({ book: selBook, account: selAcc, from: e.target.value, to: toD })} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" value={toD}
            onChange={e => setSearchParams({ book: selBook, account: selAcc, from: fromD, to: e.target.value })} />
        </div>
      </div>

      {loading && <div className="text-center py-8 text-gray-400">Loading…</div>}

      {!loading && (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr>
                <th className="table-head">Date</th>
                <th className="table-head">Narration</th>
                <th className="table-head">Ref</th>
                <th className="table-head">{selAcc ? 'Contra Account' : 'Account'}</th>
                <th className="table-head text-right">Dr</th>
                <th className="table-head text-right">Cr</th>
                {selAcc && <th className="table-head text-right">Balance</th>}
                <th className="table-head w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && (
                <tr><td colSpan={8} className="table-cell text-center text-gray-400 py-8">
                  {selBook || selAcc ? 'No entries found' : 'Select a book or account to view entries'}
                </td></tr>
              )}
              {rows.map(({ entry, line, contraLines }, i) => {
                const dr = line.debit || 0
                const cr = line.credit || 0
                runningBal += dr - cr
                const isFirstLine = i === 0 || rows[i - 1].entry.id !== entry.id
                return (
                  <tr key={`${entry.id}-${line.id}`} className="hover:bg-gray-50">
                    <td className="table-cell whitespace-nowrap text-xs">
                      {isFirstLine ? format(new Date(entry.date), 'dd MMM yyyy') : ''}
                    </td>
                    <td className="table-cell text-sm">{isFirstLine ? entry.narration : ''}</td>
                    <td className="table-cell text-xs text-gray-400">{isFirstLine ? entry.reference_no : ''}</td>
                    <td className="table-cell text-sm">
                      {selAcc && contraLines.length > 0
                        ? contraLines.map(l => l.accounts?.name).filter(Boolean).join(', ')
                        : line.accounts?.name}
                    </td>
                    <td className="table-cell text-right text-sm">{dr > 0 ? `₹${dr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : ''}</td>
                    <td className="table-cell text-right text-sm">{cr > 0 ? `₹${cr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : ''}</td>
                    {selAcc && (
                      <td className={`table-cell text-right text-sm font-medium ${runningBal >= 0 ? 'text-gray-800' : 'text-red-600'}`}>
                        ₹{Math.abs(runningBal).toLocaleString('en-IN', { minimumFractionDigits: 2 })} {runningBal >= 0 ? 'Dr' : 'Cr'}
                      </td>
                    )}
                    {isFirstLine ? (
                      <td className="table-cell">
                        <div className="flex gap-2">
                          <Link to={`/entry/${entry.id}/edit`} className="text-brand-500 hover:text-brand-700 text-xs">Edit</Link>
                          <button onClick={() => deleteEntry(entry.id)} className="text-red-400 hover:text-red-600 text-xs">Del</button>
                        </div>
                      </td>
                    ) : <td />}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
