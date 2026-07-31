import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { inr, round2, ddmmyyyy } from '../lib/gst'

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number)
  const start = `${ym}-01`
  const end = new Date(y, m, 0).toISOString().slice(0, 10) // last day of month
  return { start, end }
}

export default function GstSummary() {
  const [books,   setBooks]   = useState([])
  const [bookId,  setBookId]  = useState('')
  const [firm,    setFirm]    = useState(null)
  const [month,   setMonth]   = useState(new Date().toISOString().slice(0, 7))
  const [out,     setOut]     = useState([])   // output invoices
  const [inp,     setInp]     = useState([])   // input gst lines
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('books').select('id, name').eq('gst_enabled', true).order('name')
      setBooks(data || [])
      if (data?.length) setBookId(data[0].id)
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!bookId) return
    (async () => {
      const { start, end } = monthRange(month)
      const { data: fp } = await supabase.from('firm_profiles').select('*').eq('book_id', bookId).maybeSingle()
      setFirm(fp || null)

      // Output GST — issued tax invoices (and paid) in the month
      const { data: inv } = await supabase.from('invoices')
        .select('id, invoice_no, invoice_date, clients(name), taxable_total, cgst_total, sgst_total, igst_total, grand_total')
        .eq('book_id', bookId).in('status', ['tax', 'paid'])
        .gte('invoice_date', start).lte('invoice_date', end)
        .order('invoice_date')
      setOut(inv || [])

      // Input GST — debits to the firm's input-GST account in the month
      if (fp?.input_gst_account_id) {
        const { data: lines } = await supabase.from('journal_lines')
          .select('debit, credit, journal_entries!inner(id, date, book_id, narration, reference_no)')
          .eq('account_id', fp.input_gst_account_id)
          .eq('journal_entries.book_id', bookId)
          .gte('journal_entries.date', start).lte('journal_entries.date', end)
        setInp(lines || [])
      } else setInp([])
    })()
  }, [bookId, month])

  const outputGst = round2(out.reduce((s, r) => s + Number(r.cgst_total) + Number(r.sgst_total) + Number(r.igst_total), 0))
  const inputGst  = round2(inp.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0))
  const net = round2(outputGst - inputGst)

  if (loading) return <Spinner />
  if (!books.length) return <p className="text-sm text-amber-600">No GST-compliant firm. Enable “GST compliant” on a book in Firm Profile.</p>

  return (
    <div className="max-w-4xl space-y-5">
      <h1 className="text-2xl font-bold">GST Summary</h1>

      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="label">Firm</label>
          <select className="input" value={bookId} onChange={e => setBookId(e.target.value)}>
            {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Month</label>
          <input className="input" type="month" value={month} onChange={e => setMonth(e.target.value)} />
        </div>
      </div>

      {!firm?.input_gst_account_id && (
        <p className="text-xs text-amber-600">No Input GST account wired in Firm Profile — input credit will read ₹0.00 until you set it.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Output GST (payable)" value={outputGst} tone="red" />
        <Stat label="Input Credit (ITC)" value={inputGst} tone="green" />
        <Stat label={net >= 0 ? 'Net payable' : 'Net refund/carry-forward'} value={Math.abs(net)} tone={net >= 0 ? 'amber' : 'blue'} />
      </div>

      <Section title={`Output — Tax Invoices (${out.length})`}>
        <table className="w-full text-sm">
          <thead><tr>
            <th className="table-head">Invoice</th><th className="table-head">Client</th><th className="table-head">Date</th>
            <th className="table-head text-right">Taxable</th><th className="table-head text-right">CGST</th>
            <th className="table-head text-right">SGST</th><th className="table-head text-right">IGST</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {out.length === 0 && <tr><td colSpan={7} className="table-cell text-center text-gray-400 py-4">No invoices this month</td></tr>}
            {out.map(r => (
              <tr key={r.id}>
                <td className="table-cell font-mono text-xs">{r.invoice_no}</td>
                <td className="table-cell">{r.clients?.name}</td>
                <td className="table-cell text-xs text-gray-500">{ddmmyyyy(r.invoice_date)}</td>
                <td className="table-cell text-right">₹{inr(r.taxable_total)}</td>
                <td className="table-cell text-right">₹{inr(r.cgst_total)}</td>
                <td className="table-cell text-right">₹{inr(r.sgst_total)}</td>
                <td className="table-cell text-right">₹{inr(r.igst_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`Input — GST credit entries (${inp.length})`}>
        <table className="w-full text-sm">
          <thead><tr>
            <th className="table-head">Date</th><th className="table-head">Narration</th>
            <th className="table-head">Ref</th><th className="table-head text-right">Input GST</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {inp.length === 0 && <tr><td colSpan={4} className="table-cell text-center text-gray-400 py-4">No input-GST entries this month</td></tr>}
            {inp.map((l, i) => (
              <tr key={i}>
                <td className="table-cell text-xs text-gray-500">{ddmmyyyy(l.journal_entries?.date)}</td>
                <td className="table-cell">{l.journal_entries?.narration}</td>
                <td className="table-cell text-xs">{l.journal_entries?.reference_no || '—'}</td>
                <td className="table-cell text-right">₹{inr(Number(l.debit) - Number(l.credit))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const tones = { red: 'text-red-600', green: 'text-green-600', amber: 'text-amber-600', blue: 'text-blue-600' }
  return (
    <div className="card p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${tones[tone]}`}>₹{inr(value)}</div>
    </div>
  )
}
function Section({ title, children }) {
  return (
    <div className="card overflow-x-auto">
      <div className="px-3 py-2 border-b border-gray-100 font-semibold text-sm">{title}</div>
      {children}
    </div>
  )
}
function Spinner() {
  return <div className="flex items-center justify-center h-64">
    <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
  </div>
}
