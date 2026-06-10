import React, { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense']

const FIELD_ALIASES = {
  date:           ['date', 'dt', 'transaction date', 'txn date'],
  debit_account:  ['debit account', 'debit acc', 'dr account', 'dr acc', 'debit', 'from'],
  credit_account: ['credit account', 'credit acc', 'cr account', 'cr acc', 'credit', 'to'],
  amount:         ['amount', 'amt', 'value', 'rs', 'inr', '₹'],
  narration:      ['narration', 'description', 'particulars', 'details', 'remark', 'remarks', 'note'],
  reference:      ['reference', 'ref', 'reference no', 'ref no', 'voucher', 'cheque', 'vch'],
}

function detectColumn(headers, field) {
  const aliases = FIELD_ALIASES[field]
  return headers.findIndex(h => aliases.includes(h.toLowerCase().trim()))
}

function parseAmount(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = parseFloat(String(v).replace(/[₹,\s]/g, ''))
  return isNaN(n) ? 0 : n
}

function parseDate(v) {
  if (!v) return ''
  const s = String(v).trim()
  const formats = [
    { re: /^(\d{4})-(\d{2})-(\d{2})$/,       fn: m => `${m[1]}-${m[2]}-${m[3]}` },
    { re: /^(\d{2})\/(\d{2})\/(\d{4})$/,     fn: m => `${m[3]}-${m[2]}-${m[1]}` },
    { re: /^(\d{2})-(\d{2})-(\d{4})$/,       fn: m => `${m[3]}-${m[2]}-${m[1]}` },
    { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, fn: m => `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` },
  ]
  for (const { re, fn } of formats) {
    const m = s.match(re); if (m) return fn(m)
  }
  if (/^\d+$/.test(s)) {
    const d = XLSX.SSF.parse_date_code(parseInt(s))
    if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`
  }
  const d = new Date(s)
  if (!isNaN(d)) return d.toISOString().split('T')[0]
  return s
}

function findAccount(bookAccounts, val) {
  if (!val) return null
  const v = String(val).trim().toLowerCase()
  return bookAccounts.find(a => a.code?.toLowerCase() === v)
      || bookAccounts.find(a => a.name.toLowerCase() === v)
      || null
}

// ─── Steps ───────────────────────────────────────────────────────────────────
// 1 = upload + map columns
// 2 = resolve unknown accounts (create them)
// 3 = preview & import

export default function BulkImport() {
  const [books,        setBooks]        = useState([])
  const [accounts,     setAccounts]     = useState([])   // live list, updated after creates
  const [selBook,      setSelBook]      = useState('')
  const [rawRows,      setRawRows]      = useState([])
  const [headers,      setHeaders]      = useState([])
  const [colMap,       setColMap]       = useState({})
  const [step,         setStep]         = useState(1)
  const [unknowns,     setUnknowns]     = useState([])   // [{ name, type }]
  const [preview,      setPreview]      = useState([])
  const [basicErrors,  setBasicErrors]  = useState([])   // non-account errors
  const [importing,    setImporting]    = useState(false)
  const [creating,     setCreating]     = useState(false)
  const [done,         setDone]         = useState(null)
  const fileRef = useRef()

  useEffect(() => {
    async function load() {
      const [{ data: bk }, { data: ac }] = await Promise.all([
        supabase.from('books').select('id, name').order('name'),
        supabase.from('accounts').select('id, name, code, type, book_id').order('name'),
      ])
      setBooks(bk || [])
      setAccounts(ac || [])
      if (bk?.length) setSelBook(bk[0].id)
    }
    load()
  }, [])

  // ── file parsing ─────────────────────────────────────────────────────────
  function handleFile(e) {
    const file = e.target.files?.[0]; if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    const process = (data, hdrs) => {
      setHeaders(hdrs); setRawRows(data)
      autoMap(hdrs)
      setStep(1); setUnknowns([]); setPreview([]); setBasicErrors([]); setDone(null)
    }
    if (ext === 'csv') {
      Papa.parse(file, { header: true, skipEmptyLines: true,
        complete: ({ data, meta }) => process(data, meta.fields || []) })
    } else {
      const reader = new FileReader()
      reader.onload = ev => {
        const wb   = XLSX.read(ev.target.result, { type: 'array' })
        const ws   = wb.Sheets[wb.SheetNames[0]]
        const data = XLSX.utils.sheet_to_json(ws, { defval: '' })
        process(data, data.length ? Object.keys(data[0]) : [])
      }
      reader.readAsArrayBuffer(file)
    }
    e.target.value = ''
  }

  function autoMap(hdrs) {
    const map = {}
    for (const field of Object.keys(FIELD_ALIASES)) {
      const idx = detectColumn(hdrs, field)
      if (idx >= 0) map[field] = hdrs[idx]
    }
    setColMap(map)
  }

  // ── Step 1 → 2/3: analyse file ───────────────────────────────────────────
  function analyse() {
    const bookAccounts = accounts.filter(a => a.book_id === selBook)
    const errs         = []
    const unknownNames = new Set()

    rawRows.forEach((row, i) => {
      const rowNum    = i + 2
      const date      = parseDate(row[colMap.date])
      const drVal     = String(row[colMap.debit_account]  || '').trim()
      const crVal     = String(row[colMap.credit_account] || '').trim()
      const amount    = parseAmount(row[colMap.amount])
      const narration = String(row[colMap.narration] || '').trim()

      if (!date)       errs.push(`Row ${rowNum}: missing date`)
      if (!narration)  errs.push(`Row ${rowNum}: missing narration`)
      if (!drVal)      errs.push(`Row ${rowNum}: missing debit account`)
      if (!crVal)      errs.push(`Row ${rowNum}: missing credit account`)
      if (amount <= 0) errs.push(`Row ${rowNum}: amount must be > 0`)

      if (drVal && !findAccount(bookAccounts, drVal)) unknownNames.add(drVal)
      if (crVal && !findAccount(bookAccounts, crVal)) unknownNames.add(crVal)
    })

    setBasicErrors(errs)

    if (unknownNames.size > 0) {
      setUnknowns([...unknownNames].sort().map(name => ({ name, type: 'asset' })))
      setStep(2)
    } else if (errs.length === 0) {
      buildPreview(bookAccounts)
      setStep(3)
    }
    // if only basic errors, stay on step 1 and show them
  }

  // ── Step 2: create missing accounts ──────────────────────────────────────
  async function createMissingAccounts() {
    setCreating(true)
    try {
      const inserts = unknowns.map(u => ({
        book_id: selBook,
        name:    u.name,
        type:    u.type,
      }))
      const { data: created, error } = await supabase
        .from('accounts')
        .insert(inserts)
        .select('id, name, code, type, book_id')
      if (error) throw error

      const updatedAccounts = [...accounts, ...created]
      setAccounts(updatedAccounts)
      toast.success(`${created.length} account${created.length > 1 ? 's' : ''} created`)

      const bookAccounts = updatedAccounts.filter(a => a.book_id === selBook)
      buildPreview(bookAccounts)
      setStep(3)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setCreating(false)
    }
  }

  // ── build preview rows ────────────────────────────────────────────────────
  function buildPreview(bookAccounts) {
    const rows = rawRows.map((row, i) => ({
      rowNum:    i + 2,
      date:      parseDate(row[colMap.date]),
      drVal:     String(row[colMap.debit_account]  || '').trim(),
      crVal:     String(row[colMap.credit_account] || '').trim(),
      amount:    parseAmount(row[colMap.amount]),
      narration: String(row[colMap.narration]  || '').trim(),
      reference: String(row[colMap.reference]  || '').trim(),
      drAccount: findAccount(bookAccounts, String(row[colMap.debit_account]  || '').trim()),
      crAccount: findAccount(bookAccounts, String(row[colMap.credit_account] || '').trim()),
    }))
    setPreview(rows)
  }

  // ── import ────────────────────────────────────────────────────────────────
  async function runImport() {
    setImporting(true)
    let count = 0
    try {
      for (const entry of preview) {
        const { data: je, error } = await supabase.from('journal_entries').insert({
          book_id:      selBook,
          date:         entry.date,
          narration:    entry.narration,
          reference_no: entry.reference || null,
        }).select('id').single()
        if (error) throw error

        await supabase.from('journal_lines').insert([
          { entry_id: je.id, account_id: entry.drAccount.id, debit: entry.amount, credit: 0 },
          { entry_id: je.id, account_id: entry.crAccount.id, debit: 0, credit: entry.amount },
        ])
        count++
      }
      setDone(count)
      toast.success(`Imported ${count} journal entries`)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setImporting(false)
    }
  }

  function reset() {
    setRawRows([]); setHeaders([]); setColMap({}); setStep(1)
    setUnknowns([]); setPreview([]); setBasicErrors([]); setDone(null)
  }

  const fmt = n => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
  const bookName = books.find(b => b.id === selBook)?.name || ''

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-bold">Bulk Import</h1>

      {/* Progress indicator */}
      <div className="flex items-center gap-2 text-sm">
        {['Upload & Map', 'Create Accounts', 'Preview & Import'].map((label, i) => {
          const s = i + 1
          const active  = step === s
          const done_s  = step > s
          return (
            <React.Fragment key={s}>
              <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                active  ? 'bg-brand-600 text-white' :
                done_s  ? 'bg-green-100 text-green-700' :
                          'bg-gray-100 text-gray-400'}`}>
                {done_s ? '✓' : s} {label}
              </div>
              {i < 2 && <span className="text-gray-300">→</span>}
            </React.Fragment>
          )
        })}
      </div>

      {/* ── STEP 1: Upload & map ─────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="card p-5 space-y-4">
            <h2 className="font-semibold">Upload file</h2>
            <div className="flex gap-3 flex-wrap items-end">
              <div>
                <label className="label">Target book</label>
                <select className="input" value={selBook} onChange={e => setSelBook(e.target.value)}>
                  {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFile} />
                <button onClick={() => fileRef.current.click()} className="btn-secondary">📁 Upload CSV / Excel</button>
              </div>
              <button onClick={downloadTemplate} className="btn-secondary">⬇ Download template</button>
            </div>

            {/* Format hint */}
            <div className="bg-brand-50 border border-brand-100 rounded-lg p-3">
              <p className="text-xs font-semibold text-brand-700 mb-1">Expected columns</p>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead>
                    <tr className="text-brand-600">
                      {['Date','Debit Account','Credit Account','Amount','Narration','Reference (optional)'].map(h => (
                        <th key={h} className="text-left pr-5 py-0.5 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-gray-500">
                    <tr>
                      <td className="pr-5">15/01/2024</td><td className="pr-5">Rent Expense</td>
                      <td className="pr-5">AU BANK</td><td className="pr-5">5,000</td>
                      <td className="pr-5">Paid Jan rent</td><td>V001</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-400 mt-1">Unknown accounts will be created in the next step — no need to pre-create them.</p>
            </div>
          </div>

          {/* Column mapping */}
          {headers.length > 0 && (
            <div className="card p-5 space-y-4">
              <h2 className="font-semibold">Map columns
                <span className="text-xs font-normal text-gray-400 ml-2">auto-detected, adjust if needed</span>
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {Object.keys(FIELD_ALIASES).map(field => (
                  <div key={field}>
                    <label className="label capitalize">{field.replace('_', ' ')}</label>
                    <select className="input" value={colMap[field] || ''}
                      onChange={e => setColMap(m => ({ ...m, [field]: e.target.value }))}>
                      <option value="">— skip —</option>
                      {headers.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              {/* Basic errors (non-account) */}
              {basicErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm font-semibold text-red-700 mb-1">Fix these before continuing ({basicErrors.length})</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {basicErrors.slice(0, 10).map((e, i) => <li key={i} className="text-xs text-red-600">{e}</li>)}
                    {basicErrors.length > 10 && <li className="text-xs text-red-400">…and {basicErrors.length - 10} more</li>}
                  </ul>
                </div>
              )}

              <button onClick={analyse} className="btn-primary">
                Next → Check accounts ({rawRows.length} rows)
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── STEP 2: Resolve unknown accounts ─────────────────────────────── */}
      {step === 2 && (
        <div className="card p-5 space-y-5">
          <div>
            <h2 className="font-semibold text-lg">Create missing accounts</h2>
            <p className="text-sm text-gray-500 mt-1">
              The following account names from your file don't exist in <strong>{bookName}</strong> yet.
              Select the type for each — they'll be created automatically before importing.
            </p>
          </div>

          <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
            <div className="grid grid-cols-2 bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <span>Account name</span>
              <span>Type</span>
            </div>
            {unknowns.map((u, i) => (
              <div key={u.name} className="grid grid-cols-2 items-center px-4 py-2.5">
                <span className="text-sm font-medium">{u.name}</span>
                <select
                  className="input w-40"
                  value={u.type}
                  onChange={e => setUnknowns(us => us.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}
                >
                  {ACCOUNT_TYPES.map(t => (
                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button onClick={createMissingAccounts} disabled={creating} className="btn-primary">
              {creating ? 'Creating…' : `Create ${unknowns.length} account${unknowns.length > 1 ? 's' : ''} & continue`}
            </button>
            <button onClick={() => { setStep(1); setBasicErrors([]) }} className="btn-secondary">← Back</button>
          </div>
        </div>
      )}

      {/* ── STEP 3: Preview & import ──────────────────────────────────────── */}
      {step === 3 && !done && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="font-semibold text-lg">Preview — {preview.length} entries into <em>{bookName}</em></h2>
              <p className="text-sm text-gray-500">All accounts resolved. Review and confirm.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="btn-secondary">← Start over</button>
              <button onClick={runImport} disabled={importing} className="btn-primary px-6">
                {importing ? 'Importing…' : `Import ${preview.length} entries`}
              </button>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr>
                  <th className="table-head">Date</th>
                  <th className="table-head">Debit Account</th>
                  <th className="table-head">Credit Account</th>
                  <th className="table-head text-right">Amount</th>
                  <th className="table-head">Narration</th>
                  <th className="table-head">Ref</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {preview.slice(0, 300).map((e, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="table-cell text-xs whitespace-nowrap">{e.date}</td>
                    <td className="table-cell text-sm">{e.drAccount?.name}</td>
                    <td className="table-cell text-sm">{e.crAccount?.name}</td>
                    <td className="table-cell text-right text-sm font-medium">{fmt(e.amount)}</td>
                    <td className="table-cell text-sm">{e.narration}</td>
                    <td className="table-cell text-xs text-gray-400">{e.reference}</td>
                  </tr>
                ))}
                {preview.length > 300 && (
                  <tr><td colSpan={6} className="table-cell text-center text-gray-400 py-3 text-xs">
                    Showing first 300 of {preview.length}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Done ─────────────────────────────────────────────────────────── */}
      {done !== null && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
          <p className="text-3xl font-bold text-green-700 mb-1">✓</p>
          <p className="text-xl font-semibold text-green-700">{done} entries imported successfully</p>
          <p className="text-green-600 text-sm mt-1">into <strong>{bookName}</strong></p>
          <button onClick={reset} className="btn-secondary mt-4">Import another file</button>
        </div>
      )}
    </div>
  )
}

function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Date', 'Debit Account', 'Credit Account', 'Amount', 'Narration', 'Reference'],
    ['15/01/2024', 'Cash in Hand',  'Capital Account', 100000, 'Opening capital introduced', 'V001'],
    ['16/01/2024', 'Rent Expense',  'Cash in Hand',      5000, 'Paid January rent',           'V002'],
    ['17/01/2024', 'Purchases',     'AU BANK',           12000, 'Bought raw material',         'V003'],
    ['18/01/2024', 'AU BANK',       'Sales',              8000, 'Received payment',            'V004'],
  ])
  ws['!cols'] = [{ wch: 12 },{ wch: 22 },{ wch: 22 },{ wch: 10 },{ wch: 30 },{ wch: 10 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Journal')
  XLSX.writeFile(wb, 'accounts_import_template.xlsx')
}
