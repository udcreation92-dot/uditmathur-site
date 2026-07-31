import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'

const PROFILE_FIELDS = [
  ['firm_name', 'Firm name'], ['tagline', 'Tag line'],
  ['address', 'Address'], ['gstin', 'GSTIN'], ['state_code', 'State (name, code)'],
  ['email', 'Email'], ['mobile', 'Mobile no.'], ['pan', 'PAN'],
  ['bank_account_name', 'Bank a/c name'], ['bank_account_number', 'Bank a/c number'],
  ['bank_ifsc', 'IFSC code'], ['invoice_prefix', 'Invoice prefix'],
]

const emptyProfile = () => ({
  firm_name: '', tagline: '', logo_url: '', address: '', gstin: '', state_code: '',
  email: '', mobile: '', pan: '', bank_account_name: '', bank_account_number: '',
  bank_ifsc: '', terms: '', invoice_prefix: 'INV', next_invoice_no: 1, next_proforma_no: 1,
  debtors_account_id: '', sales_account_id: '', output_gst_account_id: '', input_gst_account_id: '',
})

export default function FirmProfile() {
  const [books,    setBooks]    = useState([])
  const [accounts, setAccounts] = useState([])
  const [bookId,   setBookId]   = useState('')
  const [book,     setBook]     = useState(null)
  const [profile,  setProfile]  = useState(emptyProfile())
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)

  useEffect(() => {
    (async () => {
      const [{ data: bk }, { data: ac }] = await Promise.all([
        supabase.from('books').select('*').order('name'),
        supabase.from('accounts').select('id, name, code, type, book_id').order('name'),
      ])
      setBooks(bk || [])
      setAccounts(ac || [])
      if (bk?.length) setBookId(bk[0].id)
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!bookId) return
    (async () => {
      const b = books.find(x => x.id === bookId)
      setBook(b || null)
      const { data } = await supabase.from('firm_profiles').select('*').eq('book_id', bookId).maybeSingle()
      setProfile(data ? { ...emptyProfile(), ...cleanNulls(data) } : emptyProfile())
    })()
  }, [bookId, books])

  const bookAccounts = accounts.filter(a => a.book_id === bookId)
  function set(k, v) { setProfile(p => ({ ...p, [k]: v })) }

  async function toggleBook(field, value) {
    const { error } = await supabase.from('books').update({ [field]: value }).eq('id', bookId)
    if (error) return toast.error(error.message)
    setBooks(bs => bs.map(b => b.id === bookId ? { ...b, [field]: value } : b))
    setBook(b => ({ ...b, [field]: value }))
  }

  function pickLogo(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 400 * 1024) return toast.error('Logo too large — keep under 400 KB')
    const reader = new FileReader()
    reader.onload = () => set('logo_url', reader.result)
    reader.readAsDataURL(file)
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    const payload = { ...profile, book_id: bookId, updated_at: new Date().toISOString() }
    // blank foreign keys -> null
    for (const k of ['debtors_account_id', 'sales_account_id', 'output_gst_account_id', 'input_gst_account_id'])
      if (!payload[k]) payload[k] = null
    payload.next_invoice_no  = parseInt(payload.next_invoice_no, 10)  || 1
    payload.next_proforma_no = parseInt(payload.next_proforma_no, 10) || 1
    const { error } = await supabase.from('firm_profiles').upsert(payload, { onConflict: 'book_id' })
    if (error) toast.error(error.message)
    else toast.success('Firm profile saved')
    setSaving(false)
  }

  if (loading) return <Spinner />
  if (!books.length) return <p className="text-gray-500">Create a book first.</p>

  const gstOn = !!book?.gst_enabled

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Firm Profile & Invoice Settings</h1>

      <div className="card p-5 space-y-4">
        <div>
          <label className="label">Book / Firm</label>
          <select className="input" value={bookId} onChange={e => setBookId(e.target.value)}>
            {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-6">
          <Toggle label="Invoicing enabled" checked={!!book?.invoicing_enabled}
            onChange={v => toggleBook('invoicing_enabled', v)} />
          <Toggle label="GST compliant" checked={gstOn}
            onChange={v => toggleBook('gst_enabled', v)} />
        </div>
        {!book?.invoicing_enabled && (
          <p className="text-xs text-amber-600">Invoicing is off for this book — the Invoices/Work Orders pages will ignore it until enabled.</p>
        )}
      </div>

      <form onSubmit={save} className="card p-5 space-y-4">
        <h2 className="font-semibold">Invoice template</h2>

        <div className="flex items-center gap-4">
          <div className="w-16 h-16 border-2 border-dashed border-gray-300 rounded flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
            {profile.logo_url
              ? <img src={profile.logo_url} alt="logo" className="w-full h-full object-contain" />
              : <span className="text-[10px] font-mono text-gray-400">LOGO</span>}
          </div>
          <div className="space-y-1">
            <input type="file" accept="image/*" onChange={pickLogo} className="text-xs" />
            {profile.logo_url && (
              <button type="button" onClick={() => set('logo_url', '')} className="block text-xs text-red-400 hover:text-red-600">Remove logo</button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PROFILE_FIELDS.map(([k, label]) => (
            <div key={k} className={k === 'address' ? 'sm:col-span-2' : ''}>
              <label className="label">{label}</label>
              {k === 'address'
                ? <textarea className="input" rows={2} value={profile[k]} onChange={e => set(k, e.target.value)} />
                : <input className={`input ${['gstin','pan','bank_ifsc','bank_account_number'].includes(k) ? 'font-mono' : ''}`}
                    value={profile[k]} onChange={e => set(k, e.target.value)} />}
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400">Invoice numbers are automatic: <span className="font-mono">{profile.invoice_prefix || 'INV'}/2026-27/0001</span> — sequence restarts each financial year (Apr–Mar) and reuses the number if you delete the latest invoice.</p>

        <div>
          <label className="label">Terms &amp; Conditions</label>
          <textarea className="input" rows={3} value={profile.terms} onChange={e => set('terms', e.target.value)}
            placeholder="Payment due within 14 days…" />
        </div>

        <div className="border-t border-gray-100 pt-4 space-y-3">
          <h3 className="font-semibold text-sm">Ledger posting accounts
            <span className="font-normal text-gray-400"> (used when a tax invoice is approved)</span>
          </h3>
          <p className="text-xs text-gray-400 -mt-1">The party ledger to debit is chosen on each invoice, not here.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <AccountPicker label="Sales / Income (Cr)" value={profile.sales_account_id}
              onChange={v => set('sales_account_id', v)} accounts={bookAccounts} />
            {gstOn && <>
              <AccountPicker label="Output GST payable (Cr)" value={profile.output_gst_account_id}
                onChange={v => set('output_gst_account_id', v)} accounts={bookAccounts} />
              <AccountPicker label="Input GST credit (Dr on expenses)" value={profile.input_gst_account_id}
                onChange={v => set('input_gst_account_id', v)} accounts={bookAccounts} />
            </>}
          </div>
          {bookAccounts.length === 0 && (
            <p className="text-xs text-amber-600">This book has no accounts yet — add them in Chart of Accounts to wire posting.</p>
          )}
        </div>

        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save Firm Profile'}</button>
      </form>
    </div>
  )
}

function AccountPicker({ label, value, onChange, accounts }) {
  return (
    <div>
      <label className="label">{label}</label>
      <select className="input" value={value || ''} onChange={e => onChange(e.target.value)}>
        <option value="">— none —</option>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.code ? ` (${a.code})` : ''} · {a.type}</option>)}
      </select>
    </div>
  )
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <span className={`relative w-10 h-6 rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-gray-300'}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </span>
      <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="text-sm font-medium">{label}</span>
    </label>
  )
}

function cleanNulls(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = v === null ? '' : v
  return out
}

function Spinner() {
  return <div className="flex items-center justify-center h-64">
    <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
  </div>
}
