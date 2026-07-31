import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'

const empty = () => ({ name: '', address: '', gstin: '', state_code: '', email: '', phone: '' })

export default function Clients() {
  const [clients, setClients] = useState([])
  const [form,    setForm]    = useState(empty())
  const [editId,  setEditId]  = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)

  async function load() {
    const { data } = await supabase.from('clients').select('*').order('name')
    setClients(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function startEdit(c) {
    setEditId(c.id)
    setForm({
      name: c.name || '', address: c.address || '', gstin: c.gstin || '',
      state_code: c.state_code || '', email: c.email || '', phone: c.phone || '',
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function reset() { setEditId(null); setForm(empty()) }

  async function save(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      address: form.address.trim() || null,
      gstin: form.gstin.trim() || null,
      state_code: form.state_code.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
    }
    const { error } = editId
      ? await supabase.from('clients').update(payload).eq('id', editId)
      : await supabase.from('clients').insert(payload)
    if (error) toast.error(error.message)
    else { toast.success(editId ? 'Client updated' : 'Client added'); reset(); load() }
    setSaving(false)
  }

  async function del(id) {
    if (!confirm('Delete this client? Work orders / invoices referencing it will block deletion.')) return
    const { error } = await supabase.from('clients').delete().eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Client deleted'); load() }
  }

  if (loading) return <Spinner />

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Client Master</h1>

      <form onSubmit={save} className="card p-5 space-y-3">
        <h2 className="font-semibold">{editId ? 'Edit client' : 'Add client'}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="label">Client name *</label>
            <input className="input" value={form.name} onChange={e => set('name', e.target.value)} required />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Address</label>
            <textarea className="input" rows={2} value={form.address} onChange={e => set('address', e.target.value)} />
          </div>
          <div>
            <label className="label">GSTIN <span className="text-gray-400">(optional / B2C if blank)</span></label>
            <input className="input font-mono" value={form.gstin} onChange={e => set('gstin', e.target.value.toUpperCase())} placeholder="29AACCS5678D1ZP" />
          </div>
          <div>
            <label className="label">State (name, code)</label>
            <input className="input" value={form.state_code} onChange={e => set('state_code', e.target.value)} placeholder="Karnataka, 29" />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" value={form.email} onChange={e => set('email', e.target.value)} />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving…' : editId ? 'Update' : 'Add client'}</button>
          {editId && <button type="button" onClick={reset} className="btn-secondary">Cancel</button>}
        </div>
      </form>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-head">Name</th>
              <th className="table-head">GSTIN</th>
              <th className="table-head">State</th>
              <th className="table-head w-24"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {clients.length === 0 && (
              <tr><td colSpan={4} className="table-cell text-center text-gray-400 py-8">No clients yet</td></tr>
            )}
            {clients.map(c => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="table-cell font-medium">{c.name}
                  {!c.gstin && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">B2C</span>}
                </td>
                <td className="table-cell font-mono text-xs">{c.gstin || '—'}</td>
                <td className="table-cell text-xs text-gray-500">{c.state_code || '—'}</td>
                <td className="table-cell text-right space-x-2">
                  <button onClick={() => startEdit(c)} className="text-brand-600 hover:underline text-xs">Edit</button>
                  <button onClick={() => del(c.id)} className="text-red-400 hover:text-red-600 text-xs">Delete</button>
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
