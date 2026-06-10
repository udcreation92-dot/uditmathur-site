import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense']

export default function ChartOfAccounts() {
  const [books,    setBooks]    = useState([])
  const [accounts, setAccounts] = useState([])
  const [links,    setLinks]    = useState([])
  const [selBook,  setSelBook]  = useState('')
  const [form,     setForm]     = useState({ name: '', code: '', type: 'asset' })
  const [linkForm, setLinkForm] = useState({ accA: '', accB: '' })
  const [loading,  setLoading]  = useState(true)

  async function load() {
    const [{ data: bk }, { data: ac }, { data: lk }] = await Promise.all([
      supabase.from('books').select('id, name').order('name'),
      supabase.from('accounts').select('*, books(name)').order('type').order('name'),
      supabase.from('inter_ledger_links').select(`id,
        account_a:account_a_id(id, name, books(name)),
        account_b:account_b_id(id, name, books(name))`),
    ])
    setBooks(bk || [])
    setAccounts(ac || [])
    setLinks(lk || [])
    if (!selBook && bk?.length) setSelBook(bk[0].id)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = accounts.filter(a => a.book_id === selBook)

  async function addAccount(e) {
    e.preventDefault()
    if (!selBook) return toast.error('Select a book first')
    const { error } = await supabase.from('accounts').insert({
      book_id: selBook,
      name: form.name.trim(),
      code: form.code.trim() || null,
      type: form.type,
    })
    if (error) toast.error(error.message)
    else { toast.success('Account added'); setForm({ name: '', code: '', type: 'asset' }); load() }
  }

  async function deleteAccount(id) {
    if (!confirm('Delete this account? Existing entries will be affected.')) return
    const { error } = await supabase.from('accounts').delete().eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Account deleted'); load() }
  }

  async function addLink(e) {
    e.preventDefault()
    if (linkForm.accA === linkForm.accB) return toast.error('Cannot link an account to itself')
    const { error } = await supabase.from('inter_ledger_links').insert({
      account_a_id: linkForm.accA,
      account_b_id: linkForm.accB,
    })
    if (error) toast.error(error.message)
    else { toast.success('Reconciliation link created'); setLinkForm({ accA: '', accB: '' }); load() }
  }

  async function deleteLink(id) {
    await supabase.from('inter_ledger_links').delete().eq('id', id)
    load()
  }

  if (loading) return <Spinner />

  return (
    <div className="space-y-8 max-w-4xl">
      <h1 className="text-2xl font-bold">Chart of Accounts</h1>

      {/* Book tabs */}
      <div className="flex gap-2 flex-wrap">
        {books.map(b => (
          <button key={b.id}
            onClick={() => setSelBook(b.id)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              selBook === b.id ? 'bg-brand-600 text-white border-brand-600' : 'border-gray-300 hover:border-brand-400'
            }`}>
            {b.name}
          </button>
        ))}
      </div>

      {/* Add account */}
      <form onSubmit={addAccount} className="card p-5">
        <h2 className="font-semibold mb-4">Add account to <em>{books.find(b => b.id === selBook)?.name || '…'}</em></h2>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Account name *</label>
            <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          </div>
          <div>
            <label className="label">Code</label>
            <input className="input" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="e.g. 1001" />
          </div>
          <div>
            <label className="label">Type *</label>
            <select className="input" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              {TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </div>
        </div>
        <button type="submit" className="btn-primary mt-3">Add Account</button>
      </form>

      {/* Accounts table */}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-head">Code</th>
              <th className="table-head">Account Name</th>
              <th className="table-head">Type</th>
              <th className="table-head w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="table-cell text-center text-gray-400 py-6">No accounts in this book</td></tr>
            )}
            {filtered.map(a => (
              <tr key={a.id} className="hover:bg-gray-50">
                <td className="table-cell text-xs text-gray-400">{a.code}</td>
                <td className="table-cell font-medium">{a.name}</td>
                <td className="table-cell">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{a.type}</span>
                </td>
                <td className="table-cell">
                  <button onClick={() => deleteAccount(a.id)} className="text-red-400 hover:text-red-600 text-xs">Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Inter-ledger links */}
      <div className="space-y-4">
        <h2 className="font-semibold text-lg">Reconciliation Links</h2>
        <p className="text-sm text-gray-500">
          Link a mirror account in one book with its counterpart in another. The Reconciliation page will flag any balance discrepancy.
        </p>

        <form onSubmit={addLink} className="card p-5">
          <h3 className="font-medium mb-3">Add link</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Account A</label>
              <select className="input" value={linkForm.accA} onChange={e => setLinkForm(f => ({ ...f, accA: e.target.value }))} required>
                <option value="">— Select —</option>
                {books.map(b => (
                  <optgroup key={b.id} label={b.name}>
                    {accounts.filter(a => a.book_id === b.id).map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Account B (mirror)</label>
              <select className="input" value={linkForm.accB} onChange={e => setLinkForm(f => ({ ...f, accB: e.target.value }))} required>
                <option value="">— Select —</option>
                {books.map(b => (
                  <optgroup key={b.id} label={b.name}>
                    {accounts.filter(a => a.book_id === b.id).map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" className="btn-primary mt-3">Create Link</button>
        </form>

        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Book A › Account</th>
                <th className="table-head">Book B › Account</th>
                <th className="table-head w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {links.length === 0 && (
                <tr><td colSpan={3} className="table-cell text-center text-gray-400 py-6">No links yet</td></tr>
              )}
              {links.map(l => (
                <tr key={l.id}>
                  <td className="table-cell text-sm">{l.account_a.books.name} › <strong>{l.account_a.name}</strong></td>
                  <td className="table-cell text-sm">{l.account_b.books.name} › <strong>{l.account_b.name}</strong></td>
                  <td className="table-cell">
                    <button onClick={() => deleteLink(l.id)} className="text-red-400 hover:text-red-600 text-xs">Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Spinner() {
  return <div className="flex items-center justify-center h-64">
    <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
  </div>
}
