import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtShort } from '../lib/dates'
import { Card } from './ui'
import ClientForm from './ClientForm'
import CodeChip from './CodeChip'

export default function TrainerHome({ code, onOpen }) {
  const [clients, setClients] = useState(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')

  const load = async () => {
    try { setClients((await api.listClients(code)).clients); setErr('') } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [code]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (f) => {
    const r = await api.saveClient(code, f)
    setAdding(false)
    await load()
    onOpen(r.client, 'profile')
  }

  const shown = (clients || []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className="inp flex-1 min-w-[10rem]" placeholder="Search clients…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-primary" onClick={() => setAdding(true)}>+ Add client</button>
      </div>

      {adding && (
        <Card icon="➕" title="New client">
          <ClientForm submitLabel="Create client & code" onSubmit={add} onCancel={() => setAdding(false)} />
        </Card>
      )}

      {err && <p className="text-sm text-brand">{err}</p>}
      {clients === null && !err && <p className="text-sm text-neutral-500">Loading clients…</p>}
      {clients?.length === 0 && !adding && (
        <div className="card p-6 text-center text-sm text-neutral-500">No clients yet — add your first one.</div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        {shown.map((c) => (
          <div key={c.id} role="button" tabIndex={0} onClick={() => onOpen(c)} onKeyDown={(e) => e.key === 'Enter' && onOpen(c)}
            className="card p-4 text-left hover:ring-2 hover:ring-brand cursor-pointer">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-head text-xl font-semibold uppercase truncate">{c.name}</div>
                <div className="text-sm text-neutral-600 truncate">{c.goal || <span className="italic text-neutral-400">No goal set</span>}</div>
              </div>
              <CodeChip code={c.code} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
              <span>Target: <b className="text-ink">{fmtShort(c.target_date)}</b></span>
              <span>Last entry: <b className="text-ink">{c.last_entry ? fmtShort(c.last_entry) : 'never'}</b></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
