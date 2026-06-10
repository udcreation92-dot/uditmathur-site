import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { uploadToDrive, isDriveConnected, requestDriveAccess } from '../lib/drive'
import toast from 'react-hot-toast'
import { format } from 'date-fns'

// ─── helpers ────────────────────────────────────────────────────────────────

const uid   = () => Date.now().toString(36) + Math.random().toString(36).slice(2)
const today = () => format(new Date(), 'yyyy-MM-dd')

const emptyLine  = () => ({ _id: uid(), account_id: '', debit: '', credit: '' })
const emptyEntry = () => ({
  _id:        uid(),
  book_id:    '',
  date:       today(),
  narration:  '',
  reference:  '',
  lines:      [emptyLine(), emptyLine()],
  pendingFiles: [],
  attachments:  [],   // existing (edit mode)
})

// ─── tiny inline "new account" popover ──────────────────────────────────────

function NewAccountPopover({ bookId, books, onCreated, onClose }) {
  const [name, setName]   = useState('')
  const [code, setCode]   = useState('')
  const [type, setType]   = useState('asset')
  const [busy, setBusy]   = useState(false)
  const ref = useRef()

  // close on outside click
  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  async function save(e) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    const { data, error } = await supabase
      .from('accounts')
      .insert({ book_id: bookId, name: name.trim(), code: code.trim() || null, type })
      .select('id, name, code, type, book_id')
      .single()
    if (error) { toast.error(error.message); setBusy(false); return }
    toast.success(`Account "${data.name}" created`)
    onCreated(data)
    onClose()
  }

  const bookName = books.find(b => b.id === bookId)?.name || ''

  return (
    <div ref={ref}
      className="absolute z-50 left-0 top-full mt-1 w-80 card p-4 shadow-xl border-brand-300 border"
      onClick={e => e.stopPropagation()}>
      <p className="text-xs font-semibold text-gray-500 mb-3">New account in <em>{bookName}</em></p>
      <form onSubmit={save} className="space-y-2">
        <input className="input" placeholder="Account name *" value={name}
          onChange={e => setName(e.target.value)} autoFocus required />
        <div className="flex gap-2">
          <input className="input" placeholder="Code (optional)" value={code}
            onChange={e => setCode(e.target.value)} />
          <select className="input" value={type} onChange={e => setType(e.target.value)}>
            {['asset','liability','equity','income','expense'].map(t =>
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
          </select>
        </div>
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className="btn-primary text-xs py-1 flex-1">
            {busy ? 'Creating…' : 'Create'}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary text-xs py-1">Cancel</button>
        </div>
      </form>
    </div>
  )
}

// ─── account select + inline create ─────────────────────────────────────────

function AccountSelect({ value, bookId, bookAccounts, books, allAccounts, onSelect, onAccountCreated }) {
  const [open, setOpen] = useState(false)

  function handleCreated(acc) {
    onAccountCreated(acc)
    onSelect(acc.id)
  }

  return (
    <div className="relative flex gap-1">
      <select
        className="input flex-1"
        value={value}
        onChange={e => onSelect(e.target.value)}
      >
        <option value="">— Select account —</option>
        {bookAccounts.map(a => (
          <option key={a.id} value={a.id}>{a.name}{a.code ? ` (${a.code})` : ''} · {a.type}</option>
        ))}
      </select>
      <button
        type="button"
        title="Create new account"
        onClick={() => setOpen(o => !o)}
        className="btn-secondary px-2 py-1 text-lg leading-none shrink-0"
      >+</button>
      {open && bookId && (
        <NewAccountPopover
          bookId={bookId}
          books={books}
          onCreated={handleCreated}
          onClose={() => setOpen(false)}
        />
      )}
      {open && !bookId && (
        <div className="absolute z-50 left-0 top-full mt-1 card p-3 text-sm text-gray-500 shadow">
          Select a book first
        </div>
      )}
    </div>
  )
}

// ─── single entry block ──────────────────────────────────────────────────────

function EntryBlock({
  entry, idx, books, allAccounts, onUpdate, onRemove,
  canRemove, driveReady, onConnectDrive, onAccountCreated,
}) {
  const fileRef = useRef()
  const scanRef = useRef()

  const bookAccounts = allAccounts.filter(a => a.book_id === entry.book_id)

  const totalDr   = entry.lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0)
  const totalCr   = entry.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
  const balanced  = Math.abs(totalDr - totalCr) < 0.01 && totalDr > 0
  const difference = Math.abs(totalDr - totalCr)

  function set(field, val) { onUpdate({ ...entry, [field]: val }) }

  function setLine(lineId, field, val) {
    onUpdate({
      ...entry,
      lines: entry.lines.map(l => l._id === lineId ? { ...l, [field]: val } : l),
    })
  }

  function addLine() { onUpdate({ ...entry, lines: [...entry.lines, emptyLine()] }) }

  function removeLine(lineId) {
    if (entry.lines.length <= 2) return
    onUpdate({ ...entry, lines: entry.lines.filter(l => l._id !== lineId) })
  }

  function pickFiles(e) {
    const files = Array.from(e.target.files || [])
    onUpdate({ ...entry, pendingFiles: [...entry.pendingFiles, ...files] })
    e.target.value = ''
  }

  function removePending(i) {
    onUpdate({ ...entry, pendingFiles: entry.pendingFiles.filter((_, j) => j !== i) })
  }

  async function removeAttachment(att) {
    await supabase.from('attachments').delete().eq('id', att.id)
    onUpdate({ ...entry, attachments: entry.attachments.filter(a => a.id !== att.id) })
    toast.success('Attachment removed')
  }

  return (
    <div className={`card overflow-hidden border-l-4 ${balanced ? 'border-l-green-400' : totalDr > 0 ? 'border-l-amber-400' : 'border-l-gray-200'}`}>

      {/* Entry header — stacks to 2-col grid on mobile */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-gray-500">Entry {idx + 1}</span>
          {canRemove && (
            <button type="button" onClick={onRemove}
              className="text-red-400 hover:text-red-600 text-sm">✕ Remove</button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <label className="label">Book *</label>
            <select className="input" value={entry.book_id} onChange={e => set('book_id', e.target.value)} required>
              <option value="">— Select —</option>
              {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Date *</label>
            <input className="input" type="date" value={entry.date}
              onChange={e => set('date', e.target.value)} required />
          </div>
          <div className="col-span-2 sm:col-span-2">
            <label className="label">Narration *</label>
            <input className="input" placeholder="Description of transaction"
              value={entry.narration} onChange={e => set('narration', e.target.value)} required />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className="label">Reference #</label>
            <input className="input" placeholder="Voucher / cheque no."
              value={entry.reference} onChange={e => set('reference', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Lines — card layout on mobile, table on md+ */}
      <div className="divide-y divide-gray-100">
        {/* Desktop table header */}
        <div className="hidden md:grid md:grid-cols-[2rem_1fr_9rem_9rem_2rem] gap-2 px-3 py-2 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          <span>#</span><span>Account</span><span className="text-right">Debit (Dr)</span><span className="text-right">Credit (Cr)</span><span></span>
        </div>

        {entry.lines.map((line, li) => (
          <div key={line._id}>
            {/* Desktop row */}
            <div className="hidden md:grid md:grid-cols-[2rem_1fr_9rem_9rem_2rem] gap-2 items-center px-3 py-2">
              <span className="text-gray-400 text-xs">{li + 1}</span>
              <AccountSelect
                value={line.account_id} bookId={entry.book_id}
                bookAccounts={bookAccounts} books={books} allAccounts={allAccounts}
                onSelect={id => setLine(line._id, 'account_id', id)}
                onAccountCreated={onAccountCreated}
              />
              <input className="input text-right" type="number" min="0" step="0.01"
                placeholder="0.00" value={line.debit}
                onChange={e => { const val = e.target.value; onUpdate({ ...entry, lines: entry.lines.map(l => l._id === line._id ? { ...l, debit: val, credit: val ? '' : l.credit } : l) }) }} />
              <input className="input text-right" type="number" min="0" step="0.01"
                placeholder="0.00" value={line.credit}
                onChange={e => { const val = e.target.value; onUpdate({ ...entry, lines: entry.lines.map(l => l._id === line._id ? { ...l, credit: val, debit: val ? '' : l.debit } : l) }) }} />
              <button type="button" onClick={() => removeLine(line._id)}
                className="text-gray-300 hover:text-red-500 text-center">✕</button>
            </div>

            {/* Mobile card */}
            <div className="md:hidden px-3 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400">Line {li + 1}</span>
                <button type="button" onClick={() => removeLine(line._id)}
                  className="text-gray-300 hover:text-red-500 text-sm">✕</button>
              </div>
              <div>
                <label className="label">Account</label>
                <AccountSelect
                  value={line.account_id} bookId={entry.book_id}
                  bookAccounts={bookAccounts} books={books} allAccounts={allAccounts}
                  onSelect={id => setLine(line._id, 'account_id', id)}
                  onAccountCreated={onAccountCreated}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Debit (Dr)</label>
                  <input className="input text-right" type="number" min="0" step="0.01"
                    inputMode="decimal" placeholder="0.00" value={line.debit}
                    onChange={e => { const val = e.target.value; onUpdate({ ...entry, lines: entry.lines.map(l => l._id === line._id ? { ...l, debit: val, credit: val ? '' : l.credit } : l) }) }} />
                </div>
                <div>
                  <label className="label">Credit (Cr)</label>
                  <input className="input text-right" type="number" min="0" step="0.01"
                    inputMode="decimal" placeholder="0.00" value={line.credit}
                    onChange={e => { const val = e.target.value; onUpdate({ ...entry, lines: entry.lines.map(l => l._id === line._id ? { ...l, credit: val, debit: val ? '' : l.debit } : l) }) }} />
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* Totals row */}
        <div className="px-3 py-2 bg-gray-50 flex items-center justify-between gap-4">
          <button type="button" onClick={addLine}
            className="text-sm text-brand-600 hover:underline font-medium">+ Add line</button>
          <div className="flex items-center gap-4 text-sm font-bold">
            <span className="text-gray-500 hidden sm:inline">Total</span>
            <span className="text-gray-700">
              Dr ₹{totalDr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </span>
            <span className="text-gray-700">
              Cr ₹{totalCr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </span>
            {totalDr > 0 && (
              balanced
                ? <span className="text-green-500 text-lg">✓</span>
                : <span className="text-amber-500 text-sm">
                    Diff ₹{difference.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
            )}
          </div>
        </div>
      </div>

      {/* Attachments */}
      <div className="px-4 py-3 border-t border-gray-100 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 font-medium">Vouchers / Attachments</span>
            {!driveReady
              ? <button type="button" onClick={onConnectDrive}
                  className="text-xs text-brand-600 hover:underline">Connect Google Drive</button>
              : <span className="text-xs text-green-600">✓ Drive ready</span>}
          </div>
          <span className="text-xs text-gray-400 hidden sm:block">
            {entry.attachments.length + entry.pendingFiles.length > 0
              ? `${entry.attachments.length + entry.pendingFiles.length} file(s) attached`
              : ''}
          </span>
        </div>

        {/* Saved attachments */}
        {entry.attachments.map(att => (
          <div key={att.id} className="flex items-center gap-2 text-sm bg-gray-50 rounded-lg px-3 py-2">
            <span className="text-base">
              {att.mime_type?.startsWith('image/') ? '🖼' : '📄'}
            </span>
            <a href={att.web_view_link} target="_blank" rel="noreferrer"
              className="text-brand-600 hover:underline truncate flex-1 text-xs">{att.file_name}</a>
            <button type="button" onClick={() => removeAttachment(att)}
              className="text-red-400 hover:text-red-600 text-xs shrink-0">Remove</button>
          </div>
        ))}

        {/* Pending uploads */}
        {entry.pendingFiles.map((f, i) => (
          <div key={i} className="flex items-center gap-2 text-sm bg-amber-50 rounded-lg px-3 py-2">
            <span className="text-base">
              {f.type?.startsWith('image/') ? '🖼' : '📄'}
            </span>
            {f.type?.startsWith('image/') && (
              <img
                src={URL.createObjectURL(f)}
                alt={f.name}
                className="w-10 h-10 object-cover rounded border border-gray-200 shrink-0"
              />
            )}
            <span className="flex-1 truncate text-xs text-gray-600">
              {f.name} <em className="text-gray-400">(pending upload)</em>
            </span>
            <button type="button" onClick={() => removePending(i)}
              className="text-red-400 hover:text-red-600 text-xs shrink-0">✕</button>
          </div>
        ))}

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap pt-1">
          {/* Hidden inputs */}
          <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={pickFiles} />
          <input ref={scanRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={pickFiles} />

          {/* Attach from files */}
          <button type="button" onClick={() => fileRef.current.click()}
            className="btn-secondary text-xs py-1.5 px-3">
            📎 Attach file
          </button>

          {/* Scan with camera — only shown on mobile/touch devices */}
          <button type="button" onClick={() => scanRef.current.click()}
            className="btn-secondary text-xs py-1.5 px-3 sm:hidden">
            📷 Scan voucher
          </button>

          {/* Always show scan button but label differently on desktop */}
          <button type="button" onClick={() => scanRef.current.click()}
            className="btn-secondary text-xs py-1.5 px-3 hidden sm:inline-flex">
            📷 Use camera
          </button>

          {!driveReady && entry.pendingFiles.length > 0 && (
            <span className="text-xs text-amber-600 self-center">
              ⚠ Connect Drive above to upload
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── main page ───────────────────────────────────────────────────────────────

export default function NewEntry() {
  const { id: editId } = useParams()
  const navigate = useNavigate()

  const [books,      setBooks]      = useState([])
  const [allAccounts,setAllAccounts]= useState([])
  const [entries,    setEntries]    = useState([emptyEntry()])
  const [saving,     setSaving]     = useState(false)
  const [driveReady, setDriveReady] = useState(isDriveConnected())

  // Load books + accounts
  useEffect(() => {
    async function load() {
      const [{ data: bk }, { data: ac }] = await Promise.all([
        supabase.from('books').select('id, name').order('name'),
        supabase.from('accounts').select('id, name, code, type, book_id').order('name'),
      ])
      setBooks(bk || [])
      setAllAccounts(ac || [])

      // Pre-fill default book
      if (bk?.length && !editId) {
        setEntries([{ ...emptyEntry(), book_id: bk[0].id }])
      }
    }
    load()
  }, [])

  // Edit mode: load single entry
  useEffect(() => {
    if (!editId) return
    async function loadEntry() {
      const { data } = await supabase
        .from('journal_entries')
        .select('*, journal_lines(*), attachments(*)')
        .eq('id', editId)
        .single()
      if (!data) return
      setEntries([{
        _id:         uid(),
        book_id:     data.book_id,
        date:        data.date,
        narration:   data.narration || '',
        reference:   data.reference_no || '',
        lines:       data.journal_lines.map(l => ({
          _id:        uid(),
          account_id: l.account_id,
          debit:      l.debit  > 0 ? String(l.debit)  : '',
          credit:     l.credit > 0 ? String(l.credit) : '',
        })),
        pendingFiles: [],
        attachments:  data.attachments || [],
      }])
    }
    loadEntry()
  }, [editId])

  function updateEntry(updated) {
    setEntries(es => es.map(e => e._id === updated._id ? updated : e))
  }

  function removeEntry(id) {
    setEntries(es => es.filter(e => e._id !== id))
  }

  function addEntry() {
    const lastBook = entries[entries.length - 1]?.book_id || books[0]?.id || ''
    setEntries(es => [...es, { ...emptyEntry(), book_id: lastBook }])
    // Scroll to bottom after render
    setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 50)
  }

  // When a new account is created inline, add it to allAccounts
  const handleAccountCreated = useCallback(acc => {
    setAllAccounts(prev => [...prev, acc].sort((a, b) => a.name.localeCompare(b.name)))
  }, [])

  async function connectDrive() {
    try { await requestDriveAccess(); setDriveReady(true); toast.success('Google Drive connected') }
    catch (e) { toast.error(e.message) }
  }

  // Validation
  const allValid = entries.every(e => {
    if (!e.book_id || !e.date || !e.narration.trim()) return false
    const dr = e.lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0)
    const cr = e.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
    return Math.abs(dr - cr) < 0.01 && dr > 0
  })

  const unbalanced = entries.filter(e => {
    const dr = e.lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0)
    const cr = e.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
    return dr > 0 && Math.abs(dr - cr) >= 0.01
  })

  async function handleSave() {
    if (!allValid) return
    setSaving(true)
    let saved = 0

    try {
      for (const entry of entries) {
        const validLines = entry.lines.filter(
          l => l.account_id && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0)
        )

        let entryId = editId
        if (editId && entries.length === 1) {
          await supabase.from('journal_entries').update({
            book_id: entry.book_id, date: entry.date,
            narration: entry.narration, reference_no: entry.reference || null,
          }).eq('id', editId)
          await supabase.from('journal_lines').delete().eq('entry_id', editId)
        } else {
          const { data, error } = await supabase.from('journal_entries').insert({
            book_id: entry.book_id, date: entry.date,
            narration: entry.narration, reference_no: entry.reference || null,
          }).select('id').single()
          if (error) throw error
          entryId = data.id
        }

        await supabase.from('journal_lines').insert(
          validLines.map(l => ({
            entry_id:   entryId,
            account_id: l.account_id,
            debit:      parseFloat(l.debit)  || 0,
            credit:     parseFloat(l.credit) || 0,
          }))
        )

        // Upload attachments
        for (const file of entry.pendingFiles) {
          if (!driveReady) continue
          try {
            const d = await uploadToDrive(file)
            await supabase.from('attachments').insert({
              entry_id: entryId, drive_file_id: d.id,
              file_name: d.name, mime_type: d.mimeType, web_view_link: d.webViewLink,
            })
          } catch { toast.error(`Drive upload failed: ${file.name}`) }
        }

        saved++
      }

      toast.success(saved === 1 ? 'Entry saved' : `${saved} entries saved`)
      navigate('/ledger')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (!books.length && !allAccounts.length) {
    return <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  }

  return (
    <div className="max-w-5xl space-y-4 pb-24">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl sm:text-2xl font-bold">{editId ? 'Edit Entry' : 'New Journal Entry'}</h1>
        <button type="button" onClick={() => navigate(-1)} className="btn-secondary text-sm">Cancel</button>
      </div>

      {/* Entry blocks */}
      {entries.map((entry, idx) => (
        <EntryBlock
          key={entry._id}
          entry={entry}
          idx={idx}
          books={books}
          allAccounts={allAccounts}
          onUpdate={updateEntry}
          onRemove={() => removeEntry(entry._id)}
          canRemove={entries.length > 1 && !editId}
          driveReady={driveReady}
          onConnectDrive={connectDrive}
          onAccountCreated={handleAccountCreated}
        />
      ))}

      {/* Add another entry (only in create mode) */}
      {!editId && (
        <button type="button" onClick={addEntry}
          className="w-full py-3 rounded-xl border-2 border-dashed border-gray-300 text-gray-400 hover:border-brand-400 hover:text-brand-600 transition-colors text-sm font-medium">
          + Add another entry
        </button>
      )}

      {/* Save bar */}
      <div className="sticky bottom-0 bg-white border-t border-gray-200 -mx-4 lg:-mx-6 px-4 lg:px-6 py-3 pb-safe flex items-center gap-3 flex-wrap shadow-lg z-10">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !allValid}
          className="btn-primary text-base px-6 py-2.5"
        >
          {saving
            ? 'Saving…'
            : editId
              ? 'Update Entry'
              : entries.length === 1
                ? 'Save Entry'
                : `Save All ${entries.length} Entries`}
        </button>

        {entries.length > 1 && (
          <span className="text-sm text-gray-500">
            {entries.filter(e => {
              const dr = e.lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0)
              const cr = e.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
              return Math.abs(dr - cr) < 0.01 && dr > 0
            }).length} / {entries.length} balanced
          </span>
        )}

        {unbalanced.length > 0 && (
          <span className="text-sm text-amber-600">
            ✗ {unbalanced.length} entr{unbalanced.length > 1 ? 'ies' : 'y'} not balanced
          </span>
        )}
      </div>
    </div>
  )
}
