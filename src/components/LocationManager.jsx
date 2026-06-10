import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function LocationManager({ locations, onUpdate }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function addLocation(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError('')
    const { error: err } = await supabase.from('locations').insert({ name: name.trim() })
    if (err) { setError(err.message) } else { setName(''); onUpdate() }
    setSaving(false)
  }

  async function deleteLocation(id) {
    if (!window.confirm('Delete this location? Tasks using it will be unassigned.')) return
    await supabase.from('locations').delete().eq('id', id)
    onUpdate()
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Locations</h2>
        <p className="text-sm text-slate-500 mt-0.5">Manage master locations to assign to tasks</p>
      </div>

      {/* Add form */}
      <form onSubmit={addLocation} className="flex gap-2">
        <input
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Location name (e.g. Office, Home, Warehouse)"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* List */}
      {locations.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <div className="text-3xl mb-2">📍</div>
          <p>No locations yet. Add one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {locations.map(loc => (
            <div key={loc.id} className="flex items-center justify-between bg-white border border-slate-100 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">📍</span>
                <span className="font-medium text-slate-800">{loc.name}</span>
              </div>
              <button
                onClick={() => deleteLocation(loc.id)}
                className="text-xs text-slate-300 hover:text-red-500 transition-colors"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
