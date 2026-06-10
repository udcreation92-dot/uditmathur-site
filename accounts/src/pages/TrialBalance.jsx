import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function TrialBalance() {
  const [books,   setBooks]   = useState([])
  const [selBook, setSelBook] = useState('')
  const [rows,    setRows]    = useState([])
  const [asOf,    setAsOf]    = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.from('books').select('id, name').order('name').then(({ data }) => {
      setBooks(data || [])
      if (data?.length) setSelBook(data[0].id)
    })
  }, [])

  useEffect(() => { if (selBook) generate() }, [selBook, asOf])

  async function generate() {
    setLoading(true)
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, name, code, type')
      .eq('book_id', selBook)
      .order('type')
      .order('name')

    const results = await Promise.all((accounts || []).map(async acc => {
      let q = supabase.from('journal_lines')
        .select('debit, credit, journal_entries!inner(book_id, date)')
        .eq('account_id', acc.id)
        .eq('journal_entries.book_id', selBook)
      if (asOf) q = q.lte('journal_entries.date', asOf)
      const { data: lines } = await q
      const dr = (lines || []).reduce((s, l) => s + (l.debit  || 0), 0)
      const cr = (lines || []).reduce((s, l) => s + (l.credit || 0), 0)
      return { ...acc, dr, cr, balance: dr - cr }
    }))

    setRows(results.filter(r => r.dr > 0 || r.cr > 0))
    setLoading(false)
  }

  const totalDr = rows.reduce((s, r) => s + r.dr, 0)
  const totalCr = rows.reduce((s, r) => s + r.cr, 0)

  const fmt = n => `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="text-2xl font-bold">Trial Balance</h1>

      <div className="card p-4 flex gap-4 flex-wrap">
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
      </div>

      {loading && <div className="text-center py-8 text-gray-400">Calculating…</div>}

      {!loading && (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Code</th>
                <th className="table-head">Account</th>
                <th className="table-head">Type</th>
                <th className="table-head text-right">Debit</th>
                <th className="table-head text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && (
                <tr><td colSpan={5} className="table-cell text-center text-gray-400 py-8">No data</td></tr>
              )}
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="table-cell text-xs text-gray-400">{r.code}</td>
                  <td className="table-cell font-medium">{r.name}</td>
                  <td className="table-cell">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{r.type}</span>
                  </td>
                  <td className="table-cell text-right">{r.dr > 0 ? fmt(r.dr) : ''}</td>
                  <td className="table-cell text-right">{r.cr > 0 ? fmt(r.cr) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-gray-300 bg-gray-50">
              <tr>
                <td colSpan={3} className="table-cell text-right font-bold">Total</td>
                <td className="table-cell text-right font-bold">{fmt(totalDr)}</td>
                <td className="table-cell text-right font-bold">{fmt(totalCr)}</td>
              </tr>
              <tr>
                <td colSpan={5} className="table-cell text-right text-sm">
                  {Math.abs(totalDr - totalCr) < 0.01
                    ? <span className="text-green-600 font-semibold">✓ Trial balance agrees</span>
                    : <span className="text-red-600 font-semibold">✗ Difference: {fmt(totalDr - totalCr)}</span>}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
