import React, { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useEntryModal } from '../context/EntryModal'
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
  drcr:        ['dr/cr', 'drcr', 'cr/dr', 'type', 'transaction type', 'txn type', 'indicator', 'dr / cr'],
  balance:     ['balance', 'bal', 'closing balance', 'running balance', 'available balance'],
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
  const [extraPicked, setExtraPicked] = useState({}) // index -> boolean (extra rows to delete)
  // filters for the missing list
  const [fAmount,   setFAmount]   = useState('')
  const [fDesc,     setFDesc]     = useState('')
  const [fDir,      setFDir]      = useState('all')
  // inline new-account creation for the counterparty
  const [showNewAcc, setShowNewAcc] = useState(false)
  const [newAccName, setNewAccName] = useState('')
  const [newAccType, setNewAccType] = useState('expense')
  // optional mirror entry in another book (cross-book transfer)
  const [showMirror, setShowMirror] = useState(false)
  const [mirrorBook, setMirrorBook] = useState('')
  const [mirrorDr,   setMirrorDr]   = useState('')
  const [mirrorCr,   setMirrorCr]   = useState('')
  const fileRef = useRef()

  const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense']

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
  const bookName = books.find(b => b.id === selBook)?.name || ''
  const { open: openEntry } = useEntryModal()

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
  // Also captures the last non-empty running balance as the statement's closing balance.
  function parseStatement() {
    const txns = []
    let closeBal = null
    for (const row of rawRows) {
      const date = parseDate(row[colMap.date])
      const desc = String(row[colMap.description] || '').trim()
      let amount = 0, direction = 'debit'
      if (colMap.debit || colMap.credit) {
        const dr = parseAmount(row[colMap.debit]), cr = parseAmount(row[colMap.credit])
        if (cr > 0) { amount = cr; direction = 'credit' } else { amount = dr; direction = 'debit' }
      } else if (colMap.amount && colMap.drcr) {
        // Single amount column + a Dr/Cr flag ("C"/"D", "Cr"/"Dr", "Credit"/"Debit").
        amount = parseAmount(row[colMap.amount])
        const flag = String(row[colMap.drcr] || '').trim().toUpperCase()
        direction = flag.startsWith('C') ? 'credit' : 'debit'
      } else {
        amount = parseAmount(row[colMap.amount])
      }
      if (date && amount > 0) txns.push({ date, amount, direction, description: desc })
      if (colMap.balance) {
        const b = row[colMap.balance]
        if (b !== '' && b !== null && b !== undefined) closeBal = parseFloat(String(b).replace(/[₹,\s]/g, ''))
      }
    }
    return { txns, closeBal }
  }

  async function runReconcile() {
    if (!selAcc) return toast.error('Pick the account this statement belongs to')
    const { txns, closeBal } = parseStatement()
    if (!txns.length) return toast.error('No transactions parsed — check your column mapping')
    setBusy(true)
    try {
      const dates = txns.map(t => t.date).sort()
      const from = shift(dates[0], -tolerance), to = shift(dates[dates.length - 1], tolerance)
      const lastDate = dates[dates.length - 1]

      const { data: rows, error } = await supabase
        .from('journal_lines')
        .select('debit, credit, journal_entries!inner(id, date, narration)')
        .eq('account_id', selAcc)
        .gte('journal_entries.date', from)
        .lte('journal_entries.date', to)
      if (error) throw error

      const ledger = (rows || []).map(r => ({
        entryId: r.journal_entries.id,
        date: r.journal_entries.date,
        signed: (r.debit || 0) - (r.credit || 0),   // + = debit (increase asset), - = credit
        amount: Math.abs((r.debit || 0) - (r.credit || 0)),
        narration: r.journal_entries.narration || '',
        used: false,
      }))

      const missing = []
      const reversed = []   // matched by amount+date but booked the wrong way
      let matched = 0
      for (const t of txns) {
        let best = -1, bestDist = Infinity
        for (let i = 0; i < ledger.length; i++) {
          if (ledger[i].used) continue
          if (Math.abs(ledger[i].amount - t.amount) >= 0.01) continue
          const d = daysApart(ledger[i].date, t.date)
          if (d <= tolerance && d < bestDist) { best = i; bestDist = d }
        }
        if (best >= 0) {
          ledger[best].used = true
          // A statement "credit" (money IN) should be a DEBIT to this asset account.
          const expectDebit = t.direction === 'credit'
          const isDebit = ledger[best].signed > 0
          if (expectDebit === isDebit) matched++
          else reversed.push({ ...t, entryId: ledger[best].entryId, narration: ledger[best].narration })
        } else {
          missing.push(t)
        }
      }
      const extra = ledger.filter(l => !l.used)

      // Ledger balance for this account as of the statement's last date (for the balance check).
      const { data: allRows } = await supabase
        .from('journal_lines')
        .select('debit, credit, journal_entries!inner(date)')
        .eq('account_id', selAcc)
        .lte('journal_entries.date', lastDate)
      const ledgerBal = (allRows || []).reduce((s, r) => s + (r.debit || 0) - (r.credit || 0), 0)

      setResult({ matched, missing, extra, reversed, total: txns.length, closeBal, ledgerBal, lastDate })
      setPicked(Object.fromEntries(missing.map((_, i) => [i, true])))
      setExtraPicked({})
      setFAmount(''); setFDesc(''); setFDir('all')
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
      const mirrorOn = showMirror && mirrorBook && mirrorDr && mirrorCr
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

        // Optional mirror entry in another book (cross-book transfer).
        if (mirrorOn) {
          const { data: mje, error: merr } = await supabase.from('journal_entries').insert({
            book_id: mirrorBook, date: t.date,
            narration: t.description || 'Statement reconciliation (mirror)',
            reference_no: null,
          }).select('id').single()
          if (merr) throw merr
          await supabase.from('journal_lines').insert([
            { entry_id: mje.id, account_id: mirrorDr, debit: t.amount, credit: 0 },
            { entry_id: mje.id, account_id: mirrorCr, debit: 0, credit: t.amount },
          ])
        }
      }
      toast.success(`Created ${count} entr${count > 1 ? 'ies' : 'y'}${mirrorOn ? ' + mirror in other book' : ''}`)
      await runReconcile() // refresh — they should now be matched
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Create a new account in the selected book and pick it as the counterparty.
  async function createAccount() {
    if (!newAccName.trim()) return toast.error('Enter an account name')
    setBusy(true)
    try {
      const { data, error } = await supabase.from('accounts')
        .insert({ book_id: selBook, name: newAccName.trim(), type: newAccType })
        .select('id, name, code, type, book_id').single()
      if (error) throw error
      setAccounts(a => [...a, data])
      setCounterparty(data.id)
      setShowNewAcc(false); setNewAccName(''); setNewAccType('expense')
      toast.success(`Account "${data.name}" created`)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Delete the checked "extra" ledger entries (the whole journal entry, both sides).
  async function deleteExtra() {
    const chosen = result.extra.filter((_, i) => extraPicked[i])
    if (!chosen.length) return toast.error('No entries selected')
    if (!confirm(`Delete ${chosen.length} journal entr${chosen.length > 1 ? 'ies' : 'y'}? This removes the entire entry (both sides) and cannot be undone.`)) return
    setBusy(true)
    try {
      const ids = [...new Set(chosen.map(e => e.entryId).filter(Boolean))]
      const { error } = await supabase.from('journal_entries').delete().in('id', ids)
      if (error) throw error
      toast.success(`Deleted ${ids.length} entr${ids.length > 1 ? 'ies' : 'y'}`)
      await runReconcile()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Missing rows after applying the amount/description/direction filters (keeps original index).
  const missingFiltered = (result?.missing || [])
    .map((t, i) => ({ t, i }))
    .filter(({ t }) =>
      (!fAmount || String(t.amount).includes(fAmount.replace(/[₹,\s]/g, ''))) &&
      (!fDesc || t.description.toLowerCase().includes(fDesc.toLowerCase())) &&
      (fDir === 'all' || (fDir === 'In' && t.direction === 'credit') || (fDir === 'Out' && t.direction === 'debit'))
    )
  const setAllMissing = val => setPicked(p => {
    const n = { ...p }; missingFiltered.forEach(({ i }) => { n[i] = val }); return n
  })
  const setAllExtra = val => setExtraPicked(
    val ? Object.fromEntries(result.extra.map((_, i) => [i, true])) : {}
  )

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
                  <label className="label capitalize">{field === 'drcr' ? 'Dr/Cr flag' : field}</label>
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Matched"  value={result.matched}          color="green" />
            <Stat label="Reversed (wrong dir)" value={result.reversed.length} color="red" />
            <Stat label="Missing"  value={result.missing.length}   color="amber" />
            <Stat label="Extra in ledger" value={result.extra.length} color="gray" />
          </div>

          {/* Balance check */}
          {result.closeBal != null && (
            (() => {
              const diff = result.ledgerBal - result.closeBal
              const ok = Math.abs(diff) < 0.01
              return (
                <div className={`rounded-xl border p-4 ${ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                    <span>Your ledger balance (as of {result.lastDate}): <strong>{fmt(result.ledgerBal)}</strong></span>
                    <span>Statement closing balance: <strong>{fmt(result.closeBal)}</strong></span>
                    <span className={ok ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold'}>
                      {ok ? '✅ Balances match' : `⚠️ Off by ${fmt(Math.abs(diff))}`}
                    </span>
                  </div>
                  {!ok && result.reversed.length > 0 && (
                    <p className="text-xs text-red-600 mt-2">Reversed entries below account for {fmt(result.reversed.reduce((s, r) => s + 2 * r.amount, 0))} of this gap (each is off by 2× its amount). Fix them and re-reconcile.</p>
                  )}
                </div>
              )
            })()
          )}
          {result.closeBal == null && (
            <p className="text-xs text-gray-400">Map the statement's <strong>Balance</strong> column above to see a ledger-vs-statement balance check.</p>
          )}

          {/* Reversed entries */}
          {result.reversed.length > 0 && (
            <div className="card p-5 space-y-3">
              <h2 className="font-semibold text-red-700">Booked the wrong way ({result.reversed.length})</h2>
              <p className="text-xs text-gray-500">These match a statement line by amount &amp; date, but the Debit/Credit is reversed in your ledger (money-in booked as out, or vice-versa). Edit each to flip it.</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr><th className="table-head">Date</th><th className="table-head text-right">Amount</th><th className="table-head">Should be</th><th className="table-head">Description</th><th className="table-head w-12"></th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.reversed.slice(0, 300).map((t, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="table-cell whitespace-nowrap text-xs">{t.date}</td>
                        <td className="table-cell text-right font-medium">{fmt(t.amount)}</td>
                        <td className="table-cell text-xs">{t.direction === 'credit' ? 'Money IN (Dr account)' : 'Money OUT (Cr account)'}</td>
                        <td className="table-cell text-xs">{t.description || t.narration}</td>
                        <td className="table-cell"><button onClick={() => openEntry({ entryId: t.entryId, onSaved: runReconcile })} className="text-brand-600 hover:text-brand-700 text-xs">Edit</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.missing.length === 0 && result.extra.length === 0 && result.reversed.length === 0 && (
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
                  <div className="flex gap-1">
                    <select className="input w-64" value={counterparty} onChange={e => setCounterparty(e.target.value)}>
                      <option value="">— Select —</option>
                      {bookAccounts.filter(a => a.id !== selAcc).map(a => <option key={a.id} value={a.id}>{a.name} · {a.type}</option>)}
                    </select>
                    <button type="button" title="New account" onClick={() => setShowNewAcc(v => !v)}
                      className="btn-secondary px-2 text-lg leading-none">+</button>
                  </div>
                </div>
                <button onClick={createMissing} disabled={busy || !counterparty} className="btn-primary">
                  Create selected entries ({Object.values(picked).filter(Boolean).length})
                </button>
              </div>

              {/* Inline new-account form */}
              {showNewAcc && (
                <div className="flex items-end gap-2 flex-wrap bg-brand-50 border border-brand-100 rounded-lg p-3">
                  <div>
                    <label className="label">New account name</label>
                    <input className="input" value={newAccName} onChange={e => setNewAccName(e.target.value)}
                      placeholder="e.g. Bank Charges" autoFocus />
                  </div>
                  <div>
                    <label className="label">Type</label>
                    <select className="input" value={newAccType} onChange={e => setNewAccType(e.target.value)}>
                      {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                    </select>
                  </div>
                  <button onClick={createAccount} disabled={busy} className="btn-primary">Create in {bookName}</button>
                  <button onClick={() => setShowNewAcc(false)} className="btn-secondary">Cancel</button>
                </div>
              )}

              {/* Optional cross-book mirror entry */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={showMirror} onChange={e => setShowMirror(e.target.checked)} />
                  <span>Also create a <strong>mirror entry in another book</strong> (cross-book transfer, e.g. Jana Bank → MAAPL)</span>
                </label>
                {showMirror && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 bg-amber-50 border border-amber-100 rounded-lg p-3">
                    <div>
                      <label className="label">Mirror book</label>
                      <select className="input" value={mirrorBook} onChange={e => { setMirrorBook(e.target.value); setMirrorDr(''); setMirrorCr('') }}>
                        <option value="">— Select —</option>
                        {books.filter(b => b.id !== selBook).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label">Debit account (in mirror book)</label>
                      <select className="input" value={mirrorDr} onChange={e => setMirrorDr(e.target.value)} disabled={!mirrorBook}>
                        <option value="">— Select —</option>
                        {accounts.filter(a => a.book_id === mirrorBook).map(a => <option key={a.id} value={a.id}>{a.name} · {a.type}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label">Credit account (in mirror book)</label>
                      <select className="input" value={mirrorCr} onChange={e => setMirrorCr(e.target.value)} disabled={!mirrorBook}>
                        <option value="">— Select —</option>
                        {accounts.filter(a => a.book_id === mirrorBook).map(a => <option key={a.id} value={a.id}>{a.name} · {a.type}</option>)}
                      </select>
                    </div>
                    <p className="text-xs text-amber-700 md:col-span-3">
                      For each selected transaction a second entry is posted in the mirror book: <strong>Dr</strong> the debit account / <strong>Cr</strong> the credit account, same date &amp; amount. Tip: filter to just the transfer rows first.
                    </p>
                  </div>
                )}
              </div>

              {/* Filters */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 bg-gray-50 rounded-lg p-3">
                <div>
                  <label className="label">Amount contains</label>
                  <input className="input" value={fAmount} onChange={e => setFAmount(e.target.value)} placeholder="e.g. 1500" />
                </div>
                <div className="col-span-2">
                  <label className="label">Description contains</label>
                  <input className="input" value={fDesc} onChange={e => setFDesc(e.target.value)} placeholder="e.g. CRED, SWIGGY" />
                </div>
                <div>
                  <label className="label">Direction</label>
                  <select className="input" value={fDir} onChange={e => setFDir(e.target.value)}>
                    <option value="all">All</option>
                    <option value="In">In (credit)</option>
                    <option value="Out">Out (debit)</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-3 text-xs">
                <button onClick={() => setAllMissing(true)}  className="text-brand-600 hover:underline font-medium">Select all{fAmount||fDesc||fDir!=='all' ? ' (filtered)' : ''}</button>
                <button onClick={() => setAllMissing(false)} className="text-gray-500 hover:underline">Deselect all{fAmount||fDesc||fDir!=='all' ? ' (filtered)' : ''}</button>
                <span className="text-gray-400">showing {missingFiltered.length} of {result.missing.length}</span>
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
                    {missingFiltered.map(({ t, i }) => (
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
                    {missingFiltered.length === 0 && (
                      <tr><td colSpan={5} className="table-cell text-center text-gray-400 py-4 text-xs">No rows match the filters</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Extra */}
          {result.extra.length > 0 && (
            <div className="card p-5 space-y-3">
              <h2 className="font-semibold">In ledger, not on this statement ({result.extra.length})</h2>
              <p className="text-xs text-gray-500">These may be from a different period, duplicates, or entries the statement doesn't cover — review, then delete any that are wrong.</p>
              <div className="flex items-center gap-3 text-xs">
                <button onClick={() => setAllExtra(true)}  className="text-brand-600 hover:underline font-medium">Select all</button>
                <button onClick={() => setAllExtra(false)} className="text-gray-500 hover:underline">Deselect all</button>
                <button onClick={deleteExtra} disabled={busy} className="ml-auto text-red-600 hover:text-red-700 font-medium">
                  🗑 Delete selected ({Object.values(extraPicked).filter(Boolean).length})
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr><th className="table-head w-8"></th><th className="table-head">Date</th><th className="table-head text-right">Amount</th><th className="table-head">Narration</th><th className="table-head w-12"></th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.extra.slice(0, 300).map((l, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="table-cell">
                          <input type="checkbox" checked={!!extraPicked[i]} onChange={e => setExtraPicked(p => ({ ...p, [i]: e.target.checked }))} />
                        </td>
                        <td className="table-cell whitespace-nowrap text-xs">{l.date}</td>
                        <td className="table-cell text-right font-medium">{fmt(l.amount)}</td>
                        <td className="table-cell text-xs">{l.narration}</td>
                        <td className="table-cell">
                          <button onClick={() => openEntry({ entryId: l.entryId, onSaved: runReconcile })} className="text-brand-600 hover:text-brand-700 text-xs">Edit</button>
                        </td>
                      </tr>
                    ))}
                    {result.extra.length > 300 && (
                      <tr><td colSpan={5} className="table-cell text-center text-gray-400 py-2 text-xs">Showing first 300 of {result.extra.length}</td></tr>
                    )}
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
    red:   'bg-red-50 border-red-200 text-red-700',
    gray:  'bg-gray-50 border-gray-200 text-gray-600',
  }
  return (
    <div className={`rounded-xl border p-4 text-center ${colors[color]}`}>
      <p className="text-3xl font-bold">{value}</p>
      <p className="text-xs font-medium mt-0.5">{label}</p>
    </div>
  )
}
