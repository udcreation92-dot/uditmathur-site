import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'
import { inr, ddmmyyyy } from '../lib/gst'

const STATUS_BADGE = {
  proforma: 'bg-amber-100 text-amber-700',
  tax:      'bg-green-100 text-green-700',
  paid:     'bg-blue-100 text-blue-700',
  void:     'bg-gray-200 text-gray-500 line-through',
}
const STATUS_LABEL = { proforma: 'Proforma', tax: 'Tax Invoice', paid: 'Paid', void: 'Void' }

export default function Invoices() {
  const navigate = useNavigate()
  const [rows,    setRows]    = useState([])
  const [books,   setBooks]   = useState([])
  const [filter,  setFilter]  = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    const [{ data: inv }, { data: bk }] = await Promise.all([
      supabase.from('invoices').select('*, clients(name), books(name)').order('created_at', { ascending: false }),
      supabase.from('books').select('id, name').eq('invoicing_enabled', true).order('name'),
    ])
    setRows(inv || [])
    setBooks(bk || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  // Delete any invoice — reverses its journal entry and unlinks WO stages first.
  async function del(inv) {
    const label = inv.status === 'proforma' ? 'proforma' : `invoice ${inv.invoice_no || ''}`
    const warn = inv.journal_entry_id
      ? `Delete ${label}? Its journal entry will be reversed (removed from the books).`
      : `Delete ${label}?`
    if (!confirm(warn)) return
    if (inv.journal_entry_id) await supabase.from('journal_entries').delete().eq('id', inv.journal_entry_id)
    await supabase.from('work_order_stages').update({ invoice_id: null }).eq('invoice_id', inv.id)
    const { error } = await supabase.from('invoices').delete().eq('id', inv.id)
    if (error) toast.error(error.message)
    else { toast.success('Deleted'); load() }
  }

  // Undo approval — revert a Tax/Paid invoice back to an editable Proforma and
  // delete its journal entry (keeps the invoice record, drops the tax number).
  async function undoApproval(inv) {
    if (!(inv.status === 'tax' || inv.status === 'paid')) return
    if (!confirm(`Undo approval of ${inv.invoice_no}? It goes back to Proforma, the journal entry is deleted, and it can be edited again. (The tax number is released.)`)) return
    if (inv.journal_entry_id) await supabase.from('journal_entries').delete().eq('id', inv.journal_entry_id)
    const { error } = await supabase.from('invoices').update({
      status: 'proforma', invoice_no: null, approved_at: null,
      journal_entry_id: null, firm_snapshot: null, client_snapshot: null,
    }).eq('id', inv.id)
    if (error) toast.error(error.message)
    else { toast.success('Reverted to Proforma & entry removed'); load() }
  }

  async function setPaid(inv, paid) {
    const { error } = await supabase.from('invoices').update({ status: paid ? 'paid' : 'tax' }).eq('id', inv.id)
    if (error) toast.error(error.message); else { toast.success(paid ? 'Marked paid' : 'Marked unpaid'); load() }
  }

  const filtered = filter ? rows.filter(r => r.book_id === filter) : rows
  if (loading) return <Spinner />

  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Invoices</h1>
        <div className="flex items-center gap-2">
          {books.length > 1 && (
            <select className="input py-1.5" value={filter} onChange={e => setFilter(e.target.value)}>
              <option value="">All firms</option>
              {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <button onClick={() => navigate('/invoices/new')} className="btn-primary text-sm">+ New Invoice</button>
        </div>
      </div>

      {books.length === 0 && <p className="text-sm text-amber-600">Enable invoicing on a book in Firm Profile to start.</p>}

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-head">Number</th>
              <th className="table-head">Firm</th>
              <th className="table-head">Client</th>
              <th className="table-head">Date</th>
              <th className="table-head text-right">Total</th>
              <th className="table-head">Status</th>
              <th className="table-head"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="table-cell text-center text-gray-400 py-8">No invoices yet</td></tr>
            )}
            {filtered.map(inv => (
              <tr key={inv.id} className="hover:bg-gray-50">
                <td className="table-cell font-mono text-xs font-medium">{inv.status === 'proforma' ? inv.proforma_no : inv.invoice_no}</td>
                <td className="table-cell text-xs">{inv.books?.name}</td>
                <td className="table-cell">{inv.clients?.name}</td>
                <td className="table-cell text-xs text-gray-500">{ddmmyyyy(inv.invoice_date)}</td>
                <td className="table-cell text-right font-medium">₹{inr(inv.grand_total)}</td>
                <td className="table-cell"><span className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE[inv.status]}`}>{STATUS_LABEL[inv.status]}</span></td>
                <td className="table-cell text-right whitespace-nowrap space-x-2 text-xs">
                  <button onClick={() => navigate(`/invoices/${inv.id}/print`)} className="text-brand-600 hover:underline">View</button>
                  {inv.status === 'proforma' && (
                    <button onClick={() => navigate(`/invoices/${inv.id}/edit`)} className="text-brand-600 hover:underline">Edit</button>
                  )}
                  {inv.status === 'tax' && (
                    <button onClick={() => setPaid(inv, true)} className="text-blue-500 hover:underline">Paid</button>
                  )}
                  {inv.status === 'paid' && (
                    <button onClick={() => setPaid(inv, false)} className="text-blue-500 hover:underline">Unpaid</button>
                  )}
                  {(inv.status === 'tax' || inv.status === 'paid') && (
                    <button onClick={() => undoApproval(inv)} className="text-amber-600 hover:underline">Undo approval</button>
                  )}
                  <button onClick={() => del(inv)} className="text-red-400 hover:text-red-600">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Spinner() {
  return <div className="flex items-center justify-center h-64">
    <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
  </div>
}
