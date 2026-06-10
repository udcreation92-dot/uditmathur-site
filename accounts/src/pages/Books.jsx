import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'

export default function Books() {
  const [books,   setBooks]   = useState([])
  const [name,    setName]    = useState('')
  const [desc,    setDesc]    = useState('')
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)

  async function load() {
    const { data } = await supabase.from('books').select('*').order('name')
    setBooks(data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function addBook(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    const { error } = await supabase.from('books').insert({ name: name.trim(), description: desc.trim() || null })
    if (error) toast.error(error.message)
    else { toast.success('Book created'); setName(''); setDesc(''); load() }
    setSaving(false)
  }

  async function deleteBook(id) {
    if (!confirm('Delete this book and ALL its entries? This cannot be undone.')) return
    const { error } = await supabase.from('books').delete().eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Book deleted'); load() }
  }

  if (loading) return <Spinner />

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Books (Ledgers)</h1>

      <form onSubmit={addBook} className="card p-5 space-y-4">
        <h2 className="font-semibold">Add new book</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Book name *</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Udit Mathur" required />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Personal / Business…" />
          </div>
        </div>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Creating…' : 'Create Book'}</button>
      </form>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-head">Book name</th>
              <th className="table-head">Description</th>
              <th className="table-head w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {books.length === 0 && (
              <tr><td colSpan={3} className="table-cell text-center text-gray-400 py-8">No books yet — create one above</td></tr>
            )}
            {books.map(b => (
              <tr key={b.id} className="hover:bg-gray-50">
                <td className="table-cell font-medium">{b.name}</td>
                <td className="table-cell text-gray-500 text-xs">{b.description}</td>
                <td className="table-cell">
                  <button onClick={() => deleteBook(b.id)} className="text-red-400 hover:text-red-600 text-xs">Delete</button>
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
