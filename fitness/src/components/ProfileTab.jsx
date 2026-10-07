import { useState } from 'react'
import { api } from '../lib/api'
import { Card } from './ui'
import ClientForm from './ClientForm'
import CodeChip from './CodeChip'

export default function ProfileTab({ code, client, onSaved, onDeleted }) {
  const [msg, setMsg] = useState('')

  const save = async (f) => {
    const r = await api.saveClient(code, f)
    onSaved(r.client); setMsg('Profile saved ✓')
  }
  const regen = async () => {
    if (!confirm(`Give ${client.name} a new code? Their old code (${client.code}) will stop working immediately.`)) return
    const r = await api.saveClient(code, client, true)
    onSaved(r.client); setMsg('New code issued — share it with the client.')
  }
  const del = async () => {
    const typed = prompt(`This permanently deletes ${client.name} and ALL their tracker data.\nType the client's name to confirm:`)
    if (typed == null) return
    if (typed.trim().toLowerCase() !== client.name.trim().toLowerCase()) { alert('Name did not match — nothing deleted.'); return }
    await api.deleteClient(code, client.id)
    onDeleted()
  }

  return (
    <div className="space-y-4">
      <Card icon="🔑" title="Access code">
        <div className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <CodeChip code={client.code} />
            <button className="btn-ghost" onClick={regen}>Generate new code</button>
          </div>
          <p className="text-xs text-neutral-500">
            The client opens <b>uditmathur.uk/fitness</b> and types this code. Anyone with the code can see and edit this tracker, so share it privately.
          </p>
        </div>
      </Card>

      <Card icon="👤" title="Client profile">
        <ClientForm key={client.id + (client.name || '')} initial={client} submitLabel="Save profile" onSubmit={save} />
        {msg && <p className="px-4 pb-4 -mt-2 text-sm text-emerald-700">{msg}</p>}
      </Card>

      <div className="card p-4 flex flex-wrap items-center justify-between gap-2 border-red-200">
        <span className="text-sm text-neutral-600">Delete this client and all of their data.</span>
        <button className="btn border border-brand text-brand hover:bg-red-50" onClick={del}>Delete client</button>
      </div>
    </div>
  )
}
