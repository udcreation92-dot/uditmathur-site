import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'
import { inr, round2, isInterstate, computeItemTax, invoiceTotals, amountInWords, finYear } from '../lib/gst'
import InvoicePrint from '../components/InvoicePrint'

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2)
const today = () => new Date().toISOString().slice(0, 10)
const emptyItem = () => ({ _id: uid(), description: '', hsn_sac: '', taxable_value: '', rate: '' })

export default function InvoiceBuilder() {
  const { id: editId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const prefill = location.state || {}

  const [books,    setBooks]    = useState([])
  const [clients,  setClients]  = useState([])
  const [accounts, setAccounts] = useState([])
  const [firm,     setFirm]     = useState(null)   // firm_profiles row for selected book
  const [loading,  setLoading]  = useState(true)
  const [busy,     setBusy]     = useState(false)
  const [status,   setStatus]   = useState('proforma')
  const [stageId,  setStageId]  = useState(prefill.stage_id || null)
  const [newLedger,setNewLedger]= useState('')   // inline "create party ledger" text

  const [form, setForm] = useState({
    book_id: prefill.book_id || '', client_id: prefill.client_id || '',
    debtor_account_id: '',
    work_order_id: prefill.work_order_id || '', invoice_date: today(), due_date: '',
    place_of_supply: '', notes: '',
    items: [prefill.prefillItem
      ? { ...emptyItem(), description: prefill.prefillItem.description || '', taxable_value: prefill.prefillItem.taxable_value ?? '' }
      : emptyItem()],
  })

  // Load master data
  useEffect(() => {
    (async () => {
      const [{ data: bk }, { data: cl }, { data: ac }] = await Promise.all([
        supabase.from('books').select('id, name, gst_enabled, invoicing_enabled').eq('invoicing_enabled', true).order('name'),
        supabase.from('clients').select('*').order('name'),
        supabase.from('accounts').select('id, name, book_id').order('name'),
      ])
      setBooks(bk || [])
      setClients(cl || [])
      setAccounts(ac || [])
      if (!editId && !prefill.book_id && bk?.length) setForm(f => ({ ...f, book_id: bk[0].id }))
      setLoading(false)
    })()
  }, [])

  // Load firm profile whenever book changes
  useEffect(() => {
    if (!form.book_id) { setFirm(null); return }
    (async () => {
      const { data } = await supabase.from('firm_profiles').select('*').eq('book_id', form.book_id).maybeSingle()
      setFirm(data || null)
    })()
  }, [form.book_id])

  // Load existing invoice (edit mode)
  useEffect(() => {
    if (!editId) return
    (async () => {
      const { data } = await supabase.from('invoices').select('*, invoice_items(*)').eq('id', editId).single()
      if (!data) return
      if (data.status !== 'proforma') { navigate(`/invoices/${editId}/print`, { replace: true }); return }
      setStatus(data.status)
      setForm({
        book_id: data.book_id, client_id: data.client_id, work_order_id: data.work_order_id || '',
        debtor_account_id: data.debtor_account_id || '',
        invoice_date: data.invoice_date, due_date: data.due_date || '',
        place_of_supply: data.place_of_supply || '', notes: data.notes || '',
        items: (data.invoice_items || []).sort((a, b) => a.seq - b.seq).map(it => ({
          _id: uid(), description: it.description || '', hsn_sac: it.hsn_sac || '',
          taxable_value: it.taxable_value, rate: round2((Number(it.cgst_rate) + Number(it.sgst_rate) + Number(it.igst_rate))),
        })),
      })
    })()
  }, [editId])

  const book = books.find(b => b.id === form.book_id)
  const gstOn = !!book?.gst_enabled
  const client = clients.find(c => c.id === form.client_id)
  const bookAccounts = accounts.filter(a => a.book_id === form.book_id)

  // Default place of supply + party ledger when client changes
  useEffect(() => {
    if (!client) return
    setForm(f => {
      const next = { ...f }
      if (!f.place_of_supply) next.place_of_supply = client.state_code || ''
      if (!f.debtor_account_id) {
        // try to match an existing ledger in this book by the client's name
        const match = accounts.find(a => a.book_id === form.book_id &&
          a.name.trim().toLowerCase() === client.name.trim().toLowerCase())
        next.debtor_account_id = match?.id || firm?.debtors_account_id || ''
      }
      return next
    })
  }, [form.client_id, firm])

  const interstate = gstOn && isInterstate(form.place_of_supply, firm?.state_code)

  // Compute each item's tax
  const computed = useMemo(() => form.items.map(it => {
    const tv = round2(it.taxable_value)
    const rate = gstOn ? (Number(it.rate) || 0) : 0
    const tax = computeItemTax(tv, rate, interstate)
    return { ...it, taxable_value: tv, ...tax }
  }), [form.items, interstate, gstOn])

  const totals = useMemo(() => invoiceTotals(computed), [computed])
  const words = amountInWords(totals.grand_total)

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function setItem(id, k, v) { setForm(f => ({ ...f, items: f.items.map(it => it._id === id ? { ...it, [k]: v } : it) })) }
  function addItem() { setForm(f => ({ ...f, items: [...f.items, emptyItem()] })) }
  function removeItem(id) { setForm(f => ({ ...f, items: f.items.length > 1 ? f.items.filter(it => it._id !== id) : f.items })) }

  const valid = form.book_id && form.client_id && form.invoice_date &&
    computed.some(it => it.taxable_value > 0)

  async function createLedger() {
    const name = newLedger.trim()
    if (!name || !form.book_id) return
    const { data, error } = await supabase.from('accounts')
      .insert({ book_id: form.book_id, name, type: 'asset' })
      .select('id, name, book_id').single()
    if (error) return toast.error(error.message)
    setAccounts(a => [...a, data])
    set('debtor_account_id', data.id)
    setNewLedger('')
    toast.success(`Ledger "${name}" created`)
  }

  // Next gap-free sequence for a book + FY. `taxSide=true` counts approved (numbered)
  // invoices, `false` counts unapproved proformas — two independent series.
  async function nextSeq(bookId, fy, taxSide, excludeId) {
    let q = supabase.from('invoices').select('seq_no')
      .eq('book_id', bookId).eq('fin_year', fy)
      .order('seq_no', { ascending: false }).limit(1)
    q = taxSide ? q.not('invoice_no', 'is', null) : q.is('invoice_no', null)
    if (excludeId) q = q.neq('id', excludeId)
    const { data } = await q.maybeSingle()
    return (data?.seq_no || 0) + 1
  }

  // ── persist proforma (insert or update) ──
  async function persist() {
    const fy = finYear(form.invoice_date)
    const base = {
      book_id: form.book_id, client_id: form.client_id,
      debtor_account_id: form.debtor_account_id || null,
      work_order_id: form.work_order_id || null,
      invoice_date: form.invoice_date, due_date: form.due_date || null,
      place_of_supply: form.place_of_supply || null, is_interstate: interstate,
      notes: form.notes || null, amount_in_words: words, fin_year: fy,
      taxable_total: totals.taxable_total, cgst_total: totals.cgst_total,
      sgst_total: totals.sgst_total, igst_total: totals.igst_total, grand_total: totals.grand_total,
    }
    let invId = editId
    if (editId) {
      const { error } = await supabase.from('invoices').update(base).eq('id', editId)
      if (error) throw error
      await supabase.from('invoice_items').delete().eq('invoice_id', editId)
    } else {
      // proforma number: next gap-free seq for this firm + FY
      const seq = await nextSeq(form.book_id, fy, false)
      const proformaNo = `PRO/${fy}/${String(seq).padStart(4, '0')}`
      const { data, error } = await supabase.from('invoices')
        .insert({ ...base, status: 'proforma', proforma_no: proformaNo, seq_no: seq }).select('id').single()
      if (error) throw error
      invId = data.id
    }
    await supabase.from('invoice_items').insert(computed.map((it, i) => ({
      invoice_id: invId, seq: i, description: it.description, hsn_sac: it.hsn_sac || null,
      taxable_value: it.taxable_value, cgst_rate: it.cgst_rate, cgst_amt: it.cgst_amt,
      sgst_rate: it.sgst_rate, sgst_amt: it.sgst_amt, igst_rate: it.igst_rate, igst_amt: it.igst_amt,
      line_total: it.line_total,
    })))
    // link WO stage (if billing from a stage) — set on save so it shows as in-progress
    if (stageId) await supabase.from('work_order_stages').update({ invoice_id: invId }).eq('id', stageId)
    return invId
  }

  async function saveProforma() {
    if (!valid) return toast.error('Add a client and at least one line with a value')
    setBusy(true)
    try {
      const invId = await persist()
      toast.success('Proforma saved')
      navigate(`/invoices/${invId}/print`)
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  async function approve() {
    if (!valid) return toast.error('Complete the invoice first')
    // require posting accounts
    if (!form.debtor_account_id) return toast.error('Pick the party ledger to debit')
    const missing = []
    if (!firm?.sales_account_id) missing.push('Sales')
    if (gstOn && totals.grand_total !== totals.taxable_total && !firm?.output_gst_account_id) missing.push('Output GST')
    if (missing.length) return toast.error(`Set posting accounts in Firm Profile: ${missing.join(', ')}`)
    if (!confirm('Approve this proforma into a Tax Invoice? It will be recorded in the books and can no longer be edited.')) return

    setBusy(true)
    try {
      const invId = await persist()
      const fy = finYear(form.invoice_date)
      const prefix = firm?.invoice_prefix || 'INV'
      const seq = await nextSeq(form.book_id, fy, true, invId)
      const invoiceNo = `${prefix}/${fy}/${String(seq).padStart(4, '0')}`

      // Build snapshots
      const firmSnap = firm ? { ...firm } : {}
      const clientSnap = client ? { ...client } : {}

      // Post journal entry
      const gstTotal = round2(totals.cgst_total + totals.sgst_total + totals.igst_total)
      const lines = [
        { account_id: form.debtor_account_id, debit: totals.grand_total, credit: 0 },
        { account_id: firm.sales_account_id, debit: 0, credit: totals.taxable_total },
      ]
      if (gstTotal > 0 && firm.output_gst_account_id)
        lines.push({ account_id: firm.output_gst_account_id, debit: 0, credit: gstTotal })

      const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
        book_id: form.book_id, date: form.invoice_date,
        narration: `Tax Invoice ${invoiceNo} — ${client?.name || ''}`, reference_no: invoiceNo,
      }).select('id').single()
      if (jeErr) throw jeErr
      const { error: jlErr } = await supabase.from('journal_lines').insert(
        lines.map(l => ({ entry_id: je.id, account_id: l.account_id, debit: l.debit, credit: l.credit }))
      )
      if (jlErr) throw jlErr

      const { error: upErr } = await supabase.from('invoices').update({
        status: 'tax', invoice_no: invoiceNo, seq_no: seq, fin_year: fy,
        approved_at: new Date().toISOString(),
        firm_snapshot: firmSnap, client_snapshot: clientSnap, journal_entry_id: je.id,
      }).eq('id', invId)
      if (upErr) throw upErr

      toast.success(`Approved — Tax Invoice ${invoiceNo} posted to books`)
      navigate(`/invoices/${invId}/print`)
    } catch (e) { toast.error(e.message) } finally { setBusy(false) }
  }

  if (loading) return <Spinner />
  if (!books.length) return <p className="text-sm text-amber-600">No invoicing-enabled firm. Enable invoicing on a book in Firm Profile.</p>

  const previewInvoice = {
    status: 'proforma', proforma_no: '(preview)', invoice_date: form.invoice_date,
    due_date: form.due_date, place_of_supply: form.place_of_supply, is_interstate: interstate,
    ...totals, amount_in_words: words,
  }
  const wo = prefill.work_order_id || form.work_order_id ? { wo_number: prefill.wo_number } : null

  return (
    <div className="max-w-5xl space-y-4 pb-28">
      <div className="flex items-center justify-between">
        <h1 className="text-xl sm:text-2xl font-bold">{editId ? 'Edit Proforma' : 'New Invoice'}</h1>
        <button onClick={() => navigate('/invoices')} className="btn-secondary text-sm">Cancel</button>
      </div>

      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Firm *</label>
            <select className="input" value={form.book_id} onChange={e => set('book_id', e.target.value)} disabled={!!editId}>
              <option value="">— Select —</option>
              {books.map(b => <option key={b.id} value={b.id}>{b.name}{b.gst_enabled ? ' · GST' : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Client *</label>
            <select className="input" value={form.client_id} onChange={e => set('client_id', e.target.value)}>
              <option value="">— Select —</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.gstin ? '' : ' (B2C)'}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Invoice date *</label>
            <input className="input" type="date" value={form.invoice_date} onChange={e => set('invoice_date', e.target.value)} />
          </div>
          <div>
            <label className="label">Due date</label>
            <input className="input" type="date" value={form.due_date} onChange={e => set('due_date', e.target.value)} />
          </div>
          <div className="sm:col-span-3">
            <label className="label">Debit ledger — party account *</label>
            <div className="flex gap-2">
              <select className="input flex-1" value={form.debtor_account_id} onChange={e => set('debtor_account_id', e.target.value)}>
                <option value="">— Select the party's ledger —</option>
                {bookAccounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.type}</option>)}
              </select>
              <input className="input w-48" placeholder="+ new ledger name" value={newLedger}
                onChange={e => setNewLedger(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createLedger() } }} />
              <button type="button" onClick={createLedger} disabled={!newLedger.trim()} className="btn-secondary text-sm shrink-0">Create</button>
            </div>
            <p className="text-xs text-gray-400 mt-1">This account is debited when the invoice is approved (defaults to a ledger matching the client's name).</p>
          </div>
          {gstOn && (
            <div className="sm:col-span-2">
              <label className="label">Place of supply (state)
                {interstate && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">Inter-state → IGST</span>}
              </label>
              <input className="input" value={form.place_of_supply} onChange={e => set('place_of_supply', e.target.value)} placeholder="Karnataka, 29" />
            </div>
          )}
        </div>
        {!firm && form.book_id && <p className="text-xs text-amber-600">This firm has no profile yet — set it up in Firm Profile (needed for numbering, bank details, and posting).</p>}
      </div>

      {/* Line items */}
      <div className="card overflow-hidden">
        <div className={`hidden md:grid ${gstOn ? 'md:grid-cols-[1fr_5rem_7rem_4rem_7rem_2rem]' : 'md:grid-cols-[1fr_7rem_7rem_2rem]'} gap-2 px-3 py-2 bg-gray-50 text-xs font-semibold text-gray-500 uppercase`}>
          <span>Description of work</span>
          <span>HSN/SAC</span>
          <span className="text-right">Taxable ₹</span>
          {gstOn && <span className="text-right">GST %</span>}
          <span className="text-right">Line total</span>
          <span></span>
        </div>
        {form.items.map((it, i) => {
          const c = computed[i]
          return (
            <div key={it._id} className={`grid grid-cols-2 ${gstOn ? 'md:grid-cols-[1fr_5rem_7rem_4rem_7rem_2rem]' : 'md:grid-cols-[1fr_7rem_7rem_2rem]'} gap-2 px-3 py-2 items-center border-t border-gray-100`}>
              <input className="input col-span-2 md:col-span-1" placeholder="Description" value={it.description} onChange={e => setItem(it._id, 'description', e.target.value)} />
              <input className="input" placeholder="HSN/SAC" value={it.hsn_sac} onChange={e => setItem(it._id, 'hsn_sac', e.target.value)} />
              <input className="input text-right" type="number" min="0" step="0.01" placeholder="0.00" value={it.taxable_value} onChange={e => setItem(it._id, 'taxable_value', e.target.value)} />
              {gstOn && <input className="input text-right" type="number" min="0" step="0.01" placeholder="18" value={it.rate} onChange={e => setItem(it._id, 'rate', e.target.value)} />}
              <span className="text-right text-sm font-medium">₹{inr(c.line_total)}</span>
              <button type="button" onClick={() => removeItem(it._id)} className="text-gray-300 hover:text-red-500 text-center">✕</button>
            </div>
          )
        })}
        <div className="px-3 py-2 bg-gray-50 flex items-center justify-between">
          <button type="button" onClick={addItem} className="text-sm text-brand-600 hover:underline font-medium">+ Add line</button>
          <div className="text-sm text-right space-y-0.5">
            <div className="text-gray-500">Taxable ₹{inr(totals.taxable_total)}
              {gstOn && (interstate
                ? <> · IGST ₹{inr(totals.igst_total)}</>
                : <> · CGST ₹{inr(totals.cgst_total)} · SGST ₹{inr(totals.sgst_total)}</>)}
            </div>
            <div className="font-bold text-base">Grand Total ₹{inr(totals.grand_total)}</div>
            <div className="text-xs text-gray-400 italic">{words}</div>
          </div>
        </div>
      </div>

      <div>
        <label className="label">Notes (internal)</label>
        <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
      </div>

      {/* Live preview */}
      <details className="card p-3">
        <summary className="cursor-pointer text-sm font-medium text-brand-600">Preview invoice layout</summary>
        <div className="invoice-preview mt-3 overflow-x-auto bg-gray-100 p-4">
          <div style={{ transform: 'scale(0.7)', transformOrigin: 'top center' }}>
            <InvoicePrint firm={firm || {}} client={client || {}} invoice={previewInvoice} workOrder={wo} items={computed} />
          </div>
        </div>
      </details>

      {/* Action bar */}
      <div className="sticky bottom-0 bg-white border-t border-gray-200 -mx-4 lg:-mx-6 px-4 lg:px-6 py-3 pb-safe flex items-center gap-3 flex-wrap shadow-lg z-10">
        <button onClick={saveProforma} disabled={busy || !valid} className="btn-secondary">{busy ? 'Saving…' : 'Save Proforma'}</button>
        <button onClick={approve} disabled={busy || !valid} className="btn-primary">Approve → Tax Invoice</button>
        <span className="text-xs text-gray-500">Proforma is not recorded in the books; approving posts the journal entry.</span>
      </div>
    </div>
  )
}

function Spinner() {
  return <div className="flex items-center justify-center h-64">
    <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
  </div>
}
