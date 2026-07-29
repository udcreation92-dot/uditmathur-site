import React, { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'

// Zero-AI statement reconciliation: upload a CSV/Excel statement for one account,
// map its columns, and match each line against existing ledger entries by amount
// + date proximity. Flags matched / missing (create them) / extra. All in-browser.

const FIELD_ALIASES = {
  date:        ['date', 'dt', 'transaction date', 'txn date', 'value date', 'posting date'],
  amount:      ['amount', 'amt', 'value', 'rs', 'inr', '₹', 'net amount', 'net'],
  debit:       ['debit', 'withdrawal', 'withdrawals', 'dr', 'paid out', 'debit amount'],
  credit:      ['credit', 'deposit', 'deposits', 'cr', 'paid in', 'credit amount'],
  description: ['description', 'narration', 'particulars', 'details', 'remarks', 'remark', 'note', 'transaction'],
}

function detectColumn(headers, field) {
  const aliases = FIELD_ALIASES[field]
  return headers.findIndex(h => aliases.includes(String(h).toLowerCase().trim()))
}

function parseAmount(v) {
  if (v === null || v === undefined || v === '') return 0
  const n = parseFloat(String(v).replace(/[₹,\s]/g, ''))
  return isNaN(n) ? 0 : Math.abs(n)
}

function parseDate(v) {
  if (!v) return ''
  const s = String(v).trim()
  const formats = [
    { re: /^(\d{4})-(\d{2})-(\d{2})/,          fn: m => `${m[1]}-${m[2]}-${m[3]}` },
    { re: /^(\d{2})\/(\d{2})\/(\d{4})$/,       fn: m => `${m[3]}-${m[2]}-${m[1]}` },
    { re: /^(\d{2})-(\d{2})-(\d{4})$/,         fn: m => `${m[3]}-${m[2]}-${m[1]}` },
    { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,   fn: m => `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` },
    { re: /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/, fn: m => { const mo = MONTHS[m[2].toLowerCase()]; const y = m[3].length === 2 ? '20'+m[3] : m[3]; return mo ? `${y}-${mo}-${m[1].padStart(2,'0')}` : '' } },
  ]
  for (const { re, fn } of formats) {
    const m = s.match(re); if (m) { const r = fn(m); if (r) return r }
  }
  if (/^\d+$/.test(s)) {
    const d = XLSX.SSF.parse_date_code(parseInt(s))
    if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`
  }
  const d = new Date(s)
  if (!isNaN(d)) return d.toISOString().split('T')[0]
  return ''
}
const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' }

const daysApart = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000)
const shift = (iso, d) => new Date(new Date(iso).getTime() + d * 86400000).toISOString().slice(0, 10)
const fmt = n => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function StatementReconcile() {
  const [books,     setBooks]     = useState([])
  const [accounts,  setAccounts]  = useState([])
  const [selBook,   setSelBook]   = useState('')
  const [selAcc,    setSelAcc]    = useState('')
  const [headers,   setHeaders]   = useState([])
  const [rawRows,   setRawRows]   = useState([])
  const [colMap,    setColMap]    = useState({})
  const [tolerance, setTolerance] = useState(4)
  const [result,    setResult]    = useState(null)   // { matched, missing, extra }
  const [busy,      setBusy]      = useState(false)
  const [counterparty, setCounterparty] = useState('')
  const [picked,    setPicked]    = useState({})     // index -> boolean (missing rows to create)
  const fileRef = useRef()

  useEffect(() => {
    (async () => {
      const [{ data: bk }, { data: ac }] = await Promise.all([
        supabase.from('books').select('id, name').order('name'),
        supabase.from('accounts').select('id, name, code, type, book_id').order('name'),
      ])
      setBooks(bk || []); setAccounts(ac || [])
      if (bk?.length) setSelBook(bk[0].id)
    })()
  }, [])

  const bookAccounts = accounts.filter(a => a.book_id === selBook)

  function handleFile(e) {
    const file = e.target.files?.[0]; if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    const process = (data, hdrs) => {
      setHeaders(hdrs); setRawRows(data); setResult(null)
      const map = {}
      for (const f of Object.keys(FIELD_ALIASES)) {
        const idx = detectColumn(hdrs, f); if (idx >= 0) map[f] = hdrs[idx]
      }
      setColMap(map)
    }
    if (ext === 'csv') {
      Papa.parse(file, { header: true, skipEmptyLines: true, complete: ({ data, meta }) => process(data, meta.fields || []) })
    } else {
      const reader = new FileReader()
      reader.onload = ev => {
        const wb = XLSX.read(ev.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const data = XLSX.utils.sheet_to_json(ws, { defval: '' })
        process(data, data.length ? Object.keys(data[0]) : [])
      }
      reader.readAsArrayBuffer(file)
    }
    e.target.value = ''
  }

  // Turn raw rows into statement transactions {date, amount, direction, description}.
  function parseStatement() {
    const txns = []
    for (const row of rawRows) {
      const date = parseDate(row[colMap.date])
      const desc = String(row[colMap.description] || '').trim()
      let amount = 0, direction = 'debit'
      if (colMap.debit || colMap.credit) {
        const dr = parseAmount(row[colMap.debit]), cr = parseAmount(row[colMap.credit])
        if (cr > 0) { amount = cr; direction = 'credit' } else { amount = dr; direction = 'debit' }
      } else {
        amount = parseAmount(row[colMap.amount])
      }
      if (date && amount > 0) txns.push({ date, amount, direction, description: desc })
    }
    return txns
  }

  async function runReconcile() {
    if (!selAcc) return toast.error('Pick the account this statement belongs to')
    const txns = parseStatement()
    if (!txns.length) return toast.error('No transactions parsed — check your column mapping')
    setBusy(true)
    try {
      const dates = txns.map(t => t.date).sort()
      const from = shift(dates[0], -tolerance), to = shift(dates[dates.length - 1], tolerance)

      const { data: rows, error } = await supabase
        .from('journal_lines')
        .select('debit, credit, journal_entries!inner(date, narration)')
        .eq('account_id', selAcc)
        .gte('journal_entries.date', from)
        .lte('journal_entries.date', to)
      if (error) throw error

      const ledger = (rows || []).map(r => ({
        date: r.journal_entries.date,
        amount: Math.abs((r.debit || 0) - (r.credit || 0)),
        narration: r.journal_entries.narration || '',
        used: false,
      }))

      const missing = []
      let matched = 0
      for (const t of txns) {
        let best = -1, bestDist = Infinity
        for (let i = 0; i < ledger.length; i++) {
          if (ledger[i].used) continue
          if (Math.abs(ledger[i].amount - t.amount) >= 0.01) continue
          const d = daysApart(ledger[i].date, t.date)
          if (d <= tolerance && d < bestDist) { best = i; bestDist = d }
        }
        if (best >= 0) { ledger[best].used = true; matched++ }
        else missing.push(t)
      }
      const extra = ledger.filter(l => !l.used)

      setResult({ matched, missing, extra, total: txns.length })
      setPicked(Object.fromEntries(missing.map((_, i) => [i, true])))
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Create ledger entries for the checked missing transactions.
  async function createMissing() {
    if (!counterparty) return toast.error('Pick a counterparty account for the new entries')
    const chosen = result.missing.filter((_, i) => picked[i])
    if (!chosen.length) return toast.error('No transactions selected')
    setBusy(true)
    let count = 0
    try {
      for (const t of chosen) {
        const { data: je, error } = await supabase.from('journal_entries').insert({
          book_id: selBook, date: t.date,
          narration: t.description || 'Statement reconciliation',
          reference_no: null,
        }).select('id').single()
        if (error) throw error
        // "credit" on statement = money into the account → Dr the account.
        const intoAccount = t.direction === 'credit'
        await supabase.from('journal_lines').insert([
          { entry_id: je.id, account_id: selAcc,        debit: intoAccount ? t.amount : 0, credit: intoAccount ? 0 : t.amount },
          { entry_id: je.id, account_id: counterparty,  debit: intoAccount ? 0 : t.amount, credit: intoAccount ? t.amount : 0 },
        ])
        count++
      }
      toast.success(`Created ${count} entries`)
      await runReconcile() // refresh — they should now be matched
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const mappedOk = colMap.date && (colMap.amount || colMap.debit || colMap.credit)

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Statement Reconcile</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload a bank/broker statement (CSV or Excel) and check it against your ledger. No AI — matching runs in your browser.
        </p>
      </div>

      {/* Setup */}
      <div className="card p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="label">Book</label>
            <select className="input" value={selBook} onChange={e => { setSelBook(e.target.value); setSelAcc(''); setCounterparty('') }}>
              {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Account this statement is for</label>
            <select className="input" value={selAcc} onChange={e => setSelAcc(e.target.value)}>
              <option value="">— Select —</option>
              {bookAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Date tolerance (± days)</label>
            <input type="number" min="0" max="30" className="input" value={tolerance}
              onChange={e => setTolerance(parseInt(e.target.value) || 0)} />
          </div>
        </div>

        <div className="flex gap-3 items-end flex-wrap">
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFile} />
          <button onClick={() => fileRef.current.click()} className="btn-secondary">📁 Upload statement</button>
          {rawRows.length > 0 && <span className="text-sm text-gray-500 self-center">{rawRows.length} rows loaded</span>}
        </div>

        {/* Column mapping */}
        {headers.length > 0 && (
          <div className="border-t border-gray-100 pt-4 space-y-3">
            <p className="font-semibold text-sm">Map columns <span className="font-normal text-gray-400">(auto-detected; use Amount OR Debit+Credit)</span></p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {Object.keys(FIELD_ALIASES).map(field => (
                <div key={field}>
                  <label className="label capitalize">{field}</label>
                  <select className="input" value={colMap[field] || ''} onChange={e => setColMap(m => ({ ...m, [field]: e.target.value }))}>
                    <option value="">— skip —</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <button onClick={runReconcile} disabled={busy || !mappedOk} className="btn-primary">
              {busy ? 'Reconciling…' : 'Reconcile'}
            </button>
          </div>
        )}
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Matched"  value={result.matched}         color="green" />
            <Stat label="Missing"  value={result.missing.length}  color="amber" />
            <Stat label="Extra in ledger" value={result.extra.length} color="gray" />
          </div>

          {result.missing.length === 0 && result.extra.length === 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-5 text-center text-green-700 font-semibold">
              ✅ All {result.total} statement lines reconcile with your ledger.
            </div>
          )}

          {/* Missing → create */}
          {result.missing.length > 0 && (
            <div className="card p-5 space-y-3">
              <h2 className="font-semibold">On statement, missing from ledger ({result.missing.length})</h2>
              <div className="flex items-end gap-3 flex-wrap">
                <div>
                  <label className="label">Counterparty account for new entries</label>
                  <select className="input w-64" value={counterparty} onChange={e => setCounterparty(e.target.value)}>
                    <option value="">— Select —</option>
                    {bookAccounts.filter(a => a.id !== selAcc).map(a => <option key={a.id} value={a.id}>{a.name} · {a.type}</option>)}
                  </select>
                </div>
                <button onClick={createMissing} disabled={busy || !counterparty} className="btn-primary">
                  Create selected entries
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr>
                      <th className="table-head w-8"></th>
                      <th className="table-head">Date</th>
                      <th className="table-head text-right">Amount</th>
                      <th className="table-head">Dir</th>
                      <th className="table-head">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.missing.map((t, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="table-cell">
                          <input type="checkbox" checked={!!picked[i]} onChange={e => setPicked(p => ({ ...p, [i]: e.target.checked }))} />
                        </td>
                        <td className="table-cell whitespace-nowrap text-xs">{t.date}</td>
                        <td className="table-cell text-right font-medium">{fmt(t.amount)}</td>
                        <td className="table-cell text-xs">{t.direction === 'credit' ? 'In' : 'Out'}</td>
                        <td className="table-cell text-xs">{t.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Extra */}
          {result.extra.length > 0 && (
            <div className="card p-5 space-y-3">
              <h2 className="font-semibold">In ledger, not on this statement ({result.extra.length})</h2>
              <p className="text-xs text-gray-500">These may be from a different period, duplicates, or entries the statement doesn't cover — review manually.</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr><th className="table-head">Date</th><th className="table-head text-right">Amount</th><th className="table-head">Narration</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.extra.slice(0, 200).map((l, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="table-cell whitespace-nowrap text-xs">{l.date}</td>
                        <td className="table-cell text-right font-medium">{fmt(l.amount)}</td>
                        <td className="table-cell text-xs">{l.narration}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color }) {
  const colors = {
    green: 'bg-green-50 border-green-200 text-green-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    gray:  'bg-gray-50 border-gray-200 text-gray-600',
  }
  return (
    <div className={`rounded-xl border p-4 text-center ${colors[color]}`}>
      <p className="text-3xl font-bold">{value}</p>
      <p className="text-xs font-medium mt-0.5">{label}</p>
    </div>
  )
}
