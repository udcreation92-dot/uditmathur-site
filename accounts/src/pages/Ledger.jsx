import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { format } from 'date-fns'
import toast from 'react-hot-toast'
import { useEntryModal, useEntryRefresh } from '../context/EntryModal'
import LedgerStatement from '../components/LedgerStatement'

export default function Ledger() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { open: openEntry } = useEntryModal()
  const [books,    setBooks]    = useState([])
  const [accounts, setAccounts] = useState([])
  const [entries,  setEntries]  = useState([])
  const [loading,  setLoading]  = useState(false)
  const [firm,     setFirm]     = useState(null)   // firm_profiles for the selected book (letterhead)
  const [opening,  setOpening]  = useState(0)       // opening balance for a selected account before 'from'

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

  // Refresh the list whenever an entry is saved via the modal.
  useEntryRefresh(loadEntries)

  // Firm letterhead for the statement (optional — only if the book has a profile)
  useEffect(() => {
    if (!selBook) { setFirm(null); return }
    supabase.from('firm_profiles').select('*').eq('book_id', selBook).maybeSingle()
      .then(({ data }) => setFirm(data || null))
  }, [selBook])

  // Opening balance = net of the selected account's lines dated before 'from'
  useEffect(() => {
    if (!selAcc || !fromD) { setOpening(0); return }
    let cancelled = false
    ;(async () => {
      const PAGE = 1000
      let offset = 0, dr = 0, cr = 0
      for (;;) {
        let q = supabase.from('journal_lines')
          .select('debit, credit, journal_entries!inner(book_id, date)')
          .eq('account_id', selAcc)
          .lt('journal_entries.date', fromD)
          .order('id', { ascending: true })
          .range(offset, offset + PAGE - 1)
        if (selBook) q = q.eq('journal_entries.book_id', selBook)
        const { data, error } = await q
        if (error || !data) break
        for (const l of data) { dr += l.debit || 0; cr += l.credit || 0 }
        if (data.length < PAGE) break
        offset += PAGE
      }
      if (!cancelled) setOpening(dr - cr)
    })()
    return () => { cancelled = true }
  }, [selAcc, fromD, selBook])

  async function loadEntries() {
    setLoading(true)
    // Page through the results — PostgREST caps a single response at 1000 rows,
    // which silently drops the oldest entries (breaking running balances) in any
    // book with more than 1000 entries.
    const PAGE = 1000
    let offset = 0
    let rows = []
    for (;;) {
      let q = supabase.from('journal_entries')
        .select(`id, date, narration, reference_no,
          journal_lines(id, debit, credit, account_id,
            accounts(id, name, type))`)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE - 1)

      if (selBook)  q = q.eq('book_id', selBook)
      if (fromD)    q = q.gte('date', fromD)
      if (toD)      q = q.lte('date', toD)

      const { data, error } = await q
      if (error) { toast.error(error.message); break }
      const batch = data || []
      rows = rows.concat(batch)
      if (batch.length < PAGE) break
      offset += PAGE
    }

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
  const account  = accounts.find(a => a.id === selAcc)
  const bookName = books.find(b => b.id === selBook)?.name || ''

  // Flatten to chronological rows and carry a running balance (from the opening).
  const baseRows = entries.flatMap(e => {
    const lines = selAcc
      ? e.journal_lines.filter(l => l.account_id === selAcc)
      : e.journal_lines
    return lines.map(l => {
      const contraLines = selAcc ? e.journal_lines.filter(cl => cl.account_id !== selAcc) : []
      return { entry: e, line: l, contraLines }
    })
  }).reverse()

  let bal = opening
  const rows = baseRows.map(r => {
    const dr = r.line.debit || 0, cr = r.line.credit || 0
    bal += dr - cr
    const particulars = selAcc
      ? (r.contraLines.map(l => l.accounts?.name).filter(Boolean).join(', ') || '—')
      : r.line.accounts?.name
    return { ...r, dr, cr, balance: bal, particulars }
  })
  const closing = rows.length ? rows[rows.length - 1].balance : opening
  const totalDr = rows.reduce((s, r) => s + r.dr, 0)
  const totalCr = rows.reduce((s, r) => s + r.cr, 0)

  function fileBase() {
    const parts = ['Ledger', account?.name || 'All-accounts']
    if (fromD || toD) parts.push(`${fromD || 'start'}_to_${toD || 'end'}`)
    return parts.join('_').replace(/[^\w-]+/g, '-')
  }

  function exportExcel() {
    if (!rows.length) return toast.error('Nothing to export')
    const data = []
    if (selAcc) data.push({ Date: '', Particulars: 'Opening balance', Narration: '', Ref: '', Debit: '', Credit: '', Balance: opening })
    for (const r of rows) {
      data.push({
        Date: format(new Date(r.entry.date), 'dd/MM/yyyy'),
        Particulars: r.particulars,
        Narration: r.entry.narration || '',
        Ref: r.entry.reference_no || '',
        Debit: r.dr || '', Credit: r.cr || '',
        ...(selAcc ? { Balance: r.balance } : {}),
      })
    }
    if (selAcc) data.push({ Date: '', Particulars: 'Closing balance', Narration: '', Ref: '', Debit: totalDr, Credit: totalCr, Balance: closing })
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Ledger')
    XLSX.writeFile(wb, `${fileBase()}.xlsx`)
  }

  function exportPDF() {
    if (!rows.length) return toast.error('Nothing to export')
    document.body.classList.add('printing-ledger')
    const cleanup = () => { document.body.classList.remove('printing-ledger'); window.removeEventListener('afterprint', cleanup) }
    window.addEventListener('afterprint', cleanup)
    setTimeout(() => window.print(), 60)
  }

  const stmtRows = rows.map(r => ({
    date: r.entry.date, narration: r.entry.narration, ref: r.entry.reference_no,
    particulars: r.particulars, dr: r.dr, cr: r.cr, balance: r.balance,
  }))

  return (
    <>
    <div className="space-y-5 ledger-screen">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Ledger</h1>
        <div className="flex items-center gap-2">
          <button onClick={exportExcel} disabled={!rows.length} className="btn-secondary text-sm disabled:opacity-40">⬇ Excel</button>
          <button onClick={exportPDF} disabled={!rows.length} className="btn-secondary text-sm disabled:opacity-40">📄 PDF</button>
          <button onClick={() => openEntry({})} className="btn-primary">+ New Entry</button>
        </div>
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
              {rows.map(({ entry, line, dr, cr, balance, particulars }, i) => {
                const isFirstLine = i === 0 || rows[i - 1].entry.id !== entry.id
                return (
                  <tr key={`${entry.id}-${line.id}`} className="hover:bg-gray-50">
                    <td className="table-cell whitespace-nowrap text-xs">
                      {isFirstLine ? format(new Date(entry.date), 'dd MMM yyyy') : ''}
                    </td>
                    <td className="table-cell text-sm">{isFirstLine ? entry.narration : ''}</td>
                    <td className="table-cell text-xs text-gray-400">{isFirstLine ? entry.reference_no : ''}</td>
                    <td className="table-cell text-sm">{particulars}</td>
                    <td className="table-cell text-right text-sm">{dr > 0 ? `₹${dr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : ''}</td>
                    <td className="table-cell text-right text-sm">{cr > 0 ? `₹${cr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : ''}</td>
                    {selAcc && (
                      <td className={`table-cell text-right text-sm font-medium ${balance >= 0 ? 'text-gray-800' : 'text-red-600'}`}>
                        ₹{Math.abs(balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })} {balance >= 0 ? 'Dr' : 'Cr'}
                      </td>
                    )}
                    {isFirstLine ? (
                      <td className="table-cell">
                        <div className="flex gap-2">
                          <button onClick={() => openEntry({ entryId: entry.id })} className="text-brand-500 hover:text-brand-700 text-xs">Edit</button>
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

    {/* Print-only "Statement of Account" (hidden on screen) */}
    <div className="ledger-print-only">
      <LedgerStatement
        firm={firm || {}}
        bookName={bookName}
        accountName={account?.name || ''}
        accountType={account?.type || ''}
        from={fromD} to={toD}
        opening={opening}
        rows={stmtRows}
        closing={closing}
        totalDr={totalDr}
        totalCr={totalCr}
      />
    </div>
    </>
  )
}
