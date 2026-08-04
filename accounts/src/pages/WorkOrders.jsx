import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'
import { inr, stageAmount, round2 } from '../lib/gst'
import { uploadToDrive, isDriveConnected, requestDriveAccess } from '../lib/drive'

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2)
const emptyStage = () => ({ _id: uid(), dbId: null, label: '', basis: 'percent', value: '', invoice_id: null })
const emptyForm = () => ({
  book_id: '', client_id: '', wo_number: '', wo_date: '', po_no: '',
  project_site: '', description: '', amount: '', status: 'open',
  stages: [emptyStage()],
  pendingFiles: [],   // File[] awaiting upload
  files: [],          // existing work_order_files rows (edit mode)
})

export default function WorkOrders() {
  const navigate = useNavigate()
  const [books,   setBooks]   = useState([])
  const [clients, setClients] = useState([])
  const [wos,     setWos]     = useState([])
  const [form,    setForm]    = useState(emptyForm())
  const [showForm,setShowForm]= useState(false)
  const [editId,  setEditId]  = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [driveReady, setDriveReady] = useState(isDriveConnected())
  const fileRef = useRef()

  async function load() {
    const [{ data: bk }, { data: cl }, { data: wo }] = await Promise.all([
      supabase.from('books').select('id, name, invoicing_enabled').eq('invoicing_enabled', true).order('name'),
      supabase.from('clients').select('id, name').order('name'),
      supabase.from('work_orders').select('*, clients(name), books(name), work_order_stages(*), work_order_files(*), invoices(id, status)').order('created_at', { ascending: false }),
    ])
    setBooks(bk || [])
    setClients(cl || [])
    setWos(wo || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }
  function setStage(id, k, v) { setForm(f => ({ ...f, stages: f.stages.map(s => s._id === id ? { ...s, [k]: v } : s) })) }
  function addStage() { setForm(f => ({ ...f, stages: [...f.stages, emptyStage()] })) }
  function removeStage(id) { setForm(f => ({ ...f, stages: f.stages.filter(s => s._id !== id) })) }

  function pickFiles(e) {
    const files = Array.from(e.target.files || [])
    setForm(f => ({ ...f, pendingFiles: [...f.pendingFiles, ...files] }))
    e.target.value = ''
  }
  function removePending(i) { setForm(f => ({ ...f, pendingFiles: f.pendingFiles.filter((_, j) => j !== i) })) }
  async function removeFile(file) {
    await supabase.from('work_order_files').delete().eq('id', file.id)
    setForm(f => ({ ...f, files: f.files.filter(x => x.id !== file.id) }))
    toast.success('File removed')
  }
  async function connectDrive() {
    try { await requestDriveAccess(); setDriveReady(true); toast.success('Google Drive connected') }
    catch (e) { toast.error(e.message) }
  }

  const woAmount = round2(form.amount)
  const stagesTotal = form.stages.reduce((s, st) => s + stageAmount(st, woAmount), 0)
  const stagesBalanced = form.stages.length === 0 || Math.abs(stagesTotal - woAmount) < 0.5

  function startEdit(wo) {
    setEditId(wo.id)
    setShowForm(true)
    const stages = (wo.work_order_stages || []).sort((a, b) => a.seq - b.seq)
    setForm({
      book_id: wo.book_id, client_id: wo.client_id,
      wo_number: wo.wo_number || '', wo_date: wo.wo_date || '', po_no: wo.po_no || '',
      project_site: wo.project_site || '', description: wo.description || '',
      amount: wo.amount ?? '', status: wo.status,
      stages: stages.length
        ? stages.map(s => ({ _id: uid(), dbId: s.id, label: s.label || '', basis: s.basis, value: s.value ?? '', invoice_id: s.invoice_id }))
        : [emptyStage()],
      pendingFiles: [],
      files: wo.work_order_files || [],
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function cancelForm() { setForm(emptyForm()); setEditId(null); setShowForm(false) }

  async function save(e) {
    e.preventDefault()
    if (!form.book_id || !form.client_id) return toast.error('Pick firm and client')
    setSaving(true)

    const header = {
      book_id: form.book_id, client_id: form.client_id,
      wo_number: form.wo_number.trim() || null, wo_date: form.wo_date || null,
      po_no: form.po_no.trim() || null, project_site: form.project_site.trim() || null,
      description: form.description.trim() || null, amount: woAmount, status: form.status,
    }

    let woId = editId
    if (editId) {
      const { error } = await supabase.from('work_orders').update(header).eq('id', editId)
      if (error) { toast.error(error.message); setSaving(false); return }
      // Replace only UNBILLED stages; billed stages (linked to an invoice) stay untouched.
      await supabase.from('work_order_stages').delete().eq('work_order_id', editId).is('invoice_id', null)
    } else {
      const { data: wo, error } = await supabase.from('work_orders').insert(header).select('id').single()
      if (error) { toast.error(error.message); setSaving(false); return }
      woId = wo.id
    }

    // Insert the current unbilled stages (billed ones already persisted in edit mode)
    const stages = form.stages.filter(s => !s.invoice_id && (s.label.trim() || s.value))
    if (stages.length) {
      const { error: se } = await supabase.from('work_order_stages').insert(
        stages.map((s, i) => ({
          work_order_id: woId, seq: (s.invoice_id ? 0 : 100) + i,
          label: s.label.trim() || `Stage ${i + 1}`, basis: s.basis, value: round2(s.value),
        }))
      )
      if (se) toast.error(se.message)
    }

    // Upload any pending WO document(s) to Drive and record them
    for (const file of form.pendingFiles) {
      if (!driveReady) { toast.error('Connect Google Drive to upload the WO document'); break }
      try {
        const d = await uploadToDrive(file)
        await supabase.from('work_order_files').insert({
          work_order_id: woId, drive_file_id: d.id, file_name: d.name,
          mime_type: d.mimeType, web_view_link: d.webViewLink,
        })
      } catch { toast.error(`Drive upload failed: ${file.name}`) }
    }

    toast.success(editId ? 'Work order updated' : 'Work order created')
    cancelForm(); load(); setSaving(false)
  }

  async function del(id) {
    if (!confirm('Delete this work order and its stages?')) return
    const { error } = await supabase.from('work_orders').delete().eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Deleted'); load() }
  }

  function billStage(wo, stage) {
    navigate('/invoices/new', { state: {
      book_id: wo.book_id, client_id: wo.client_id, work_order_id: wo.id,
      prefillItem: { description: stage.label, taxable_value: stageAmount(stage, wo.amount) },
      stage_id: stage.id,
    } })
  }

  if (loading) return <Spinner />

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Work Orders</h1>
        <button onClick={() => showForm ? cancelForm() : (setEditId(null), setForm(emptyForm()), setShowForm(true))} className="btn-primary text-sm">{showForm ? 'Close' : '+ New Work Order'}</button>
      </div>

      {books.length === 0 && (
        <p className="text-sm text-amber-600">No invoicing-enabled firm yet. Enable invoicing on a book in Firm Profile first.</p>
      )}

      {showForm && books.length > 0 && (
        <form onSubmit={save} className="card p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Firm *</label>
              <select className="input" value={form.book_id} onChange={e => set('book_id', e.target.value)} required>
                <option value="">— Select —</option>
                {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Client *</label>
              <select className="input" value={form.client_id} onChange={e => set('client_id', e.target.value)} required>
                <option value="">— Select —</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">WO number</label>
              <input className="input" value={form.wo_number} onChange={e => set('wo_number', e.target.value)} />
            </div>
            <div>
              <label className="label">WO date</label>
              <input className="input" type="date" value={form.wo_date} onChange={e => set('wo_date', e.target.value)} />
            </div>
            <div>
              <label className="label">PO no.</label>
              <input className="input" value={form.po_no} onChange={e => set('po_no', e.target.value)} />
            </div>
            <div>
              <label className="label">WO amount (₹) *</label>
              <input className="input text-right" type="number" min="0" step="0.01" value={form.amount} onChange={e => set('amount', e.target.value)} required />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Project / Site</label>
              <input className="input" value={form.project_site} onChange={e => set('project_site', e.target.value)} placeholder="Solaris Greens, Phase 2, Tower C" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Description</label>
              <textarea className="input" rows={2} value={form.description} onChange={e => set('description', e.target.value)} />
            </div>
          </div>

          {/* Stages / payment terms */}
          <div className="border-t border-gray-100 pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-sm">Payment terms / stages</span>
              <span className={`text-xs ${stagesBalanced ? 'text-green-600' : 'text-amber-600'}`}>
                Σ ₹{inr(stagesTotal)} / ₹{inr(woAmount)} {stagesBalanced ? '✓' : '(mismatch)'}
              </span>
            </div>
            <div className="space-y-2">
              {form.stages.map((s, i) => {
                const billed = !!s.invoice_id
                return (
                <div key={s._id} className="grid grid-cols-[1fr_5rem_6rem_6rem_1.5rem] gap-2 items-center">
                  <input className="input" placeholder={`Stage ${i + 1} label (e.g. On mobilization)`} value={s.label} disabled={billed} onChange={e => setStage(s._id, 'label', e.target.value)} />
                  <select className="input" value={s.basis} disabled={billed} onChange={e => setStage(s._id, 'basis', e.target.value)}>
                    <option value="percent">%</option>
                    <option value="amount">₹</option>
                  </select>
                  <input className="input text-right" type="number" min="0" step="0.01" placeholder={s.basis === 'percent' ? '%' : '₹'} value={s.value} disabled={billed} onChange={e => setStage(s._id, 'value', e.target.value)} />
                  <span className="text-xs text-gray-500 text-right">₹{inr(stageAmount(s, woAmount))}</span>
                  {billed
                    ? <span className="text-[10px] px-1 py-0.5 rounded bg-green-100 text-green-700 text-center" title="Already billed — locked">🔒</span>
                    : <button type="button" onClick={() => removeStage(s._id)} className="text-gray-300 hover:text-red-500">✕</button>}
                </div>
                )
              })}
            </div>
            <button type="button" onClick={addStage} className="text-sm text-brand-600 hover:underline mt-2">+ Add stage</button>
            {form.stages.some(s => s.invoice_id) && <p className="text-xs text-gray-400 mt-1">🔒 Billed stages are locked — they're linked to an invoice.</p>}
          </div>

          {/* Original WO document(s) */}
          <div className="border-t border-gray-100 pt-3 space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-semibold text-sm">Original work order (PDF/scan)</span>
              {driveReady
                ? <span className="text-xs text-green-600">✓ Drive ready</span>
                : <button type="button" onClick={connectDrive} className="text-xs text-brand-600 hover:underline">Connect Google Drive</button>}
            </div>
            {form.files.map(f => (
              <div key={f.id} className="flex items-center gap-2 text-sm bg-gray-50 rounded-lg px-3 py-2">
                <span>{f.mime_type?.startsWith('image/') ? '🖼' : '📄'}</span>
                <a href={f.web_view_link} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline truncate flex-1 text-xs">{f.file_name}</a>
                <button type="button" onClick={() => removeFile(f)} className="text-red-400 hover:text-red-600 text-xs shrink-0">Remove</button>
              </div>
            ))}
            {form.pendingFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-sm bg-amber-50 rounded-lg px-3 py-2">
                <span>{f.type?.startsWith('image/') ? '🖼' : '📄'}</span>
                <span className="flex-1 truncate text-xs text-gray-600">{f.name} <em className="text-gray-400">(pending upload)</em></span>
                <button type="button" onClick={() => removePending(i)} className="text-red-400 hover:text-red-600 text-xs shrink-0">✕</button>
              </div>
            ))}
            <input ref={fileRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={pickFiles} />
            <button type="button" onClick={() => fileRef.current.click()} className="btn-secondary text-xs py-1.5 px-3">📎 Attach WO document</button>
            {!driveReady && form.pendingFiles.length > 0 && <span className="text-xs text-amber-600 ml-2">⚠ Connect Drive above to upload</span>}
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving…' : editId ? 'Update Work Order' : 'Create Work Order'}</button>
            <button type="button" onClick={cancelForm} className="btn-secondary">Cancel</button>
          </div>
        </form>
      )}

      {/* List */}
      <div className="space-y-4">
        {wos.length === 0 && <p className="text-gray-400 text-sm">No work orders yet.</p>}
        {wos.map(wo => {
          const stages = (wo.work_order_stages || []).sort((a, b) => a.seq - b.seq)
          return (
            <div key={wo.id} className="card p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">{wo.wo_number || '(no number)'} · {wo.clients?.name}</div>
                  <div className="text-xs text-gray-500">{wo.books?.name} · {wo.project_site || wo.description || ''}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold">₹{inr(wo.amount)}</div>
                  <div className="space-x-2">
                    <button onClick={() => startEdit(wo)} className="text-xs text-brand-600 hover:underline">Edit</button>
                    <button onClick={() => del(wo.id)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
                  </div>
                </div>
              </div>
              {(wo.work_order_files || []).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {wo.work_order_files.map(f => (
                    <a key={f.id} href={f.web_view_link} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1 text-brand-600 hover:underline">
                      {f.mime_type?.startsWith('image/') ? '🖼' : '📄'} {f.file_name}
                    </a>
                  ))}
                </div>
              )}
              {stages.length > 0 && (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {stages.map(s => {
                      const billed = !!s.invoice_id
                      return (
                        <tr key={s.id}>
                          <td className="py-1.5">{s.label}</td>
                          <td className="py-1.5 text-gray-500 text-xs">{s.basis === 'percent' ? `${s.value}%` : '₹ fixed'}</td>
                          <td className="py-1.5 text-right">₹{inr(stageAmount(s, wo.amount))}</td>
                          <td className="py-1.5 text-right w-28">
                            {billed
                              ? <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700">Billed</span>
                              : <button onClick={() => billStage(wo, s)} className="text-xs btn-secondary py-1 px-2">Bill stage →</button>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              <button onClick={() => navigate('/invoices/new', { state: { book_id: wo.book_id, client_id: wo.client_id, work_order_id: wo.id } })}
                className="text-xs text-brand-600 hover:underline">+ Ad-hoc invoice against this WO</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Spinner() {
  return <div className="flex items-center justify-center h-64">
    <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
  </div>
}
