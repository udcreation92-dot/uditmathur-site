import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense']
const ROLES = ['other', 'savings', 'current', 'credit_card', 'trading', 'investment']
const ROLE_LABELS = {
  other: 'Other', savings: 'Savings', current: 'Current',
  credit_card: 'Credit Card', trading: 'Trading', investment: 'Investment',
}
const ROLE_COLORS = {
  savings:     'bg-green-100 text-green-700',
  current:     'bg-blue-100 text-blue-700',
  credit_card: 'bg-red-100 text-red-700',
  trading:     'bg-purple-100 text-purple-700',
  investment:  'bg-indigo-100 text-indigo-700',
  other:       'bg-gray-100 text-gray-500',
}

export default function ChartOfAccounts() {
  const [books,        setBooks]        = useState([])
  const [accounts,     setAccounts]     = useState([])
  const [settingsMap,  setSettingsMap]  = useState({})
  const [links,        setLinks]        = useState([])
  const [selBook,      setSelBook]      = useState('')
  const [form,         setForm]         = useState({ name: '', code: '', type: 'asset' })
  const [linkForm,     setLinkForm]     = useState({ accA: '', accB: '' })
  const [editId,       setEditId]       = useState(null)
  const [settingsForm, setSettingsForm] = useState({ role: 'other', rate: '', minBalance: '', ccReserve: '' })
  const [loading,      setLoading]      = useState(true)

  async function load() {
    const [{ data: bk }, { data: ac }, { data: lk }, { data: st }] = await Promise.all([
      supabase.from('books').select('id, name').order('name'),
      supabase.from('accounts').select('*, books(name)').order('type').order('name'),
      supabase.from('inter_ledger_links').select(`id,
        account_a:account_a_id(id, name, books(name)),
        account_b:account_b_id(id, name, books(name))`),
      supabase.from('account_settings').select('*'),
    ])
    setBooks(bk || [])
    setAccounts(ac || [])
    setLinks(lk || [])
    setSettingsMap(Object.fromEntries((st || []).map(s => [s.account_id, s])))
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

  function openSettings(a) {
    const s = settingsMap[a.id]
    setSettingsForm({
      role:       s?.account_role      || 'other',
      rate:       s?.interest_rate_pa  != null ? String(s.interest_rate_pa)  : '',
      minBalance: s?.min_balance       != null ? String(s.min_balance)       : '',
      ccReserve:  s?.cc_reserve_amount != null ? String(s.cc_reserve_amount) : '',
    })
    setEditId(editId === a.id ? null : a.id)
  }

  async function saveSettings(accountId) {
    const payload = {
      account_id:        accountId,
      account_role:      settingsForm.role,
      interest_rate_pa:  parseFloat(settingsForm.rate)       || 0,
      min_balance:       parseFloat(settingsForm.minBalance) || 0,
      cc_reserve_amount: parseFloat(settingsForm.ccReserve)  || 0,
      updated_at:        new Date().toISOString(),
    }
    const { error } = await supabase
      .from('account_settings')
      .upsert(payload, { onConflict: 'account_id' })
    if (error) toast.error(error.message)
    else { toast.success('Settings saved'); setEditId(null); load() }
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
              <th className="table-head">Role</th>
              <th className="table-head text-right">Rate / Min Bal</th>
              <th className="table-head w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="table-cell text-center text-gray-400 py-6">
                  No accounts in this book
                </td>
              </tr>
            )}
            {filtered.map(a => {
              const s    = settingsMap[a.id]
              const role = s?.account_role || 'other'
              return (
                <React.Fragment key={a.id}>
                  <tr className={`hover:bg-gray-50 ${editId === a.id ? 'bg-brand-50' : ''}`}>
                    <td className="table-cell text-xs text-gray-400">{a.code}</td>
                    <td className="table-cell font-medium">{a.name}</td>
                    <td className="table-cell">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                        {a.type}
                      </span>
                    </td>
                    <td className="table-cell">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${ROLE_COLORS[role]}`}>
                        {ROLE_LABELS[role]}
                      </span>
                    </td>
                    <td className="table-cell text-right text-xs text-gray-500">
                      {s ? (
                        <>
                          {s.interest_rate_pa > 0 ? `${Number(s.interest_rate_pa).toFixed(2)}% p.a.` : '—'}
                          {s.min_balance > 0 && (
                            <span className="ml-1 text-gray-400">
                              / ₹{Number(s.min_balance).toLocaleString('en-IN')}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-300">not set</span>
                      )}
                    </td>
                    <td className="table-cell">
                      <div className="flex items-center gap-2 justify-end">
                        <button
                          onClick={() => openSettings(a)}
                          className={`text-xs transition-colors ${
                            editId === a.id
                              ? 'text-brand-600 font-semibold'
                              : 'text-gray-400 hover:text-brand-600'
                          }`}
                          title="Fund optimizer settings"
                        >
                          ⚙
                        </button>
                        <button
                          onClick={() => deleteAccount(a.id)}
                          className="text-red-400 hover:text-red-600 text-xs"
                        >
                          Del
                        </button>
                      </div>
                    </td>
                  </tr>
                  {editId === a.id && (
                    <tr className="bg-brand-50">
                      <td colSpan={6} className="px-5 py-4">
                        <div className="space-y-3">
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            Fund optimizer settings — {a.name}
                          </p>
                          <div className="flex flex-wrap gap-3 items-end">
                            <div>
                              <label className="label">Role</label>
                              <select
                                className="input w-40"
                                value={settingsForm.role}
                                onChange={e => setSettingsForm(f => ({ ...f, role: e.target.value }))}
                              >
                                {ROLES.map(r => (
                                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="label">Interest rate (% p.a.)</label>
                              <input
                                className="input w-36"
                                type="number"
                                min="0"
                                step="0.001"
                                placeholder="e.g. 7.5"
                                value={settingsForm.rate}
                                onChange={e => setSettingsForm(f => ({ ...f, rate: e.target.value }))}
                              />
                            </div>
                            <div>
                              <label className="label">Min balance (AMB / MAB) ₹</label>
                              <input
                                className="input w-44"
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="e.g. 10000"
                                value={settingsForm.minBalance}
                                onChange={e => setSettingsForm(f => ({ ...f, minBalance: e.target.value }))}
                              />
                            </div>
                            <div>
                              <label className="label">CC reserve invested here ₹</label>
                              <input
                                className="input w-44"
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="e.g. 200000"
                                value={settingsForm.ccReserve}
                                onChange={e => setSettingsForm(f => ({ ...f, ccReserve: e.target.value }))}
                              />
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => saveSettings(a.id)}
                                className="btn-primary text-sm"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setEditId(null)}
                                className="btn-secondary text-sm"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                          <p className="text-xs text-gray-400">
                            Role determines how this account is treated in the Fund Optimizer.
                            Leave as <em>Other</em> to exclude it from analysis.
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
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
