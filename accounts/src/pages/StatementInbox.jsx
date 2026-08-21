import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'
import { useEntryModal } from '../context/EntryModal'

// Statement Inbox / Review — the human-approval surface for the statement-automation
// pipeline. Claude (via the Statements MCP connector) reads forwarded bank / credit-card /
// broker statements and contract notes, then queues:
//   • stmt_draft_entry  — proposed journal entries from contract notes (Drafts tab)
//   • stmt_recon_report — reconcile results for statements (Reconcile tab)
// Approving a draft posts the real double-entry to journal_entries / journal_lines.

const money = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function StatementInbox() {
  const [tab, setTab]       = useState('drafts')
  const [loading, setLoad]  = useState(true)
  const [drafts, setDrafts] = useState([])
  const [recon, setRecon]   = useState([])
  const [busy, setBusy]     = useState(null)   // id with an in-flight action
  const modal = useEntryModal()

  async function load() {
    setLoad(true)
    const [d, r] = await Promise.all([
      supabase.from('stmt_draft_entry')
        .select('*, stmt_inbox(source, kind, subject, file_name, book_id)')
        .in('status', ['draft', 'posted', 'rejected'])
        .order('created_at', { ascending: false }),
      supabase.from('stmt_recon_report')
        .select('*, stmt_inbox(source, kind, subject, file_name)')
        .order('created_at', { ascending: false }),
    ])
    if (d.error) toast.error(d.error.message)
    if (r.error) toast.error(r.error.message)
    setDrafts(d.data || [])
    setRecon(r.data || [])
    setLoad(false)
  }
  useEffect(() => { load() }, [])

  // Open the full New-Entry editor pre-filled with the draft, so the user can change
  // accounts, add a cross-book mirror entry, etc. On save it posts real entries; we then
  // mark the draft consumed.
  function openEditor(draft) {
    const initial = [{
      book_id:   draft.book_id || draft.stmt_inbox?.book_id || '',
      date:      draft.entry_date,
      narration: draft.narration || '',
      reference: draft.reference_no || '',
      lines: (draft.lines || []).map((l) => ({ account_id: l.account_id || '', debit: l.debit || '', credit: l.credit || '' })),
    }]
    modal.open({
      initial,
      onSaved: async (ids) => {
        await supabase.from('stmt_draft_entry')
          .update({ status: 'posted', posted_entry_id: (ids && ids[0]) || null, updated_at: new Date().toISOString() })
          .eq('id', draft.id)
        await rememberPayee(draft.payee, ids)
        const { count } = await supabase.from('stmt_draft_entry')
          .select('id', { count: 'exact', head: true }).eq('inbox_id', draft.inbox_id).eq('status', 'draft')
        if (!count) await supabase.from('stmt_inbox').update({ status: 'done' }).eq('id', draft.inbox_id)
        load()
      },
    })
  }

  async function approve(draft) {
    const lines = draft.lines || []
    const dr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const cr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
    if (Math.abs(dr - cr) >= 0.01) return toast.error(`Does not balance (Dr ${money(dr)} vs Cr ${money(cr)})`)
    if (dr <= 0) return toast.error('Entry total is zero')
    const bookId = draft.book_id || draft.stmt_inbox?.book_id
    if (!bookId) return toast.error('No book on this draft')
    setBusy(draft.id)
    try {
      // resolve account ids (drafts normally carry account_id; fall back to name-in-book)
      const resolved = []
      for (const l of lines) {
        let aid = l.account_id
        if (!aid && l.account_name) {
          const { data } = await supabase.from('accounts').select('id')
            .eq('book_id', bookId).ilike('name', l.account_name).limit(1).maybeSingle()
          aid = data?.id
        }
        if (!aid) throw new Error(`Cannot resolve account "${l.account_name || '?'}"`)
        resolved.push({ account_id: aid, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })
      }
      const { data: entry, error: eErr } = await supabase.from('journal_entries')
        .insert({ book_id: bookId, date: draft.entry_date, narration: draft.narration, reference_no: draft.reference_no || null })
        .select('id').single()
      if (eErr) throw eErr
      const { error: lErr } = await supabase.from('journal_lines')
        .insert(resolved.map((l) => ({ ...l, entry_id: entry.id })))
      if (lErr) throw lErr
      await supabase.from('stmt_draft_entry')
        .update({ status: 'posted', posted_entry_id: entry.id, lines, updated_at: new Date().toISOString() })
        .eq('id', draft.id)
      await rememberPayee(draft.payee, [entry.id])
      // close the statement if nothing else is pending on it
      const { count } = await supabase.from('stmt_draft_entry')
        .select('id', { count: 'exact', head: true }).eq('inbox_id', draft.inbox_id).eq('status', 'draft')
      if (!count) await supabase.from('stmt_inbox').update({ status: 'done' }).eq('id', draft.inbox_id)
      toast.success('Posted to ledger')
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function reject(draft) {
    setBusy(draft.id)
    try {
      const { error } = await supabase.from('stmt_draft_entry')
        .update({ status: 'rejected', updated_at: new Date().toISOString() }).eq('id', draft.id)
      if (error) throw error
      toast.success('Rejected')
      await load()
    } catch (e) { toast.error(e.message) } finally { setBusy(null) }
  }

  async function markReconDone(inboxId) {
    try {
      const { error } = await supabase.from('stmt_inbox').update({ status: 'done' }).eq('id', inboxId)
      if (error) throw error
      toast.success('Marked done')
      await load()
    } catch (e) { toast.error(e.message) }
  }

  // Learn: map the draft's payee → the category (income/expense) account actually posted, into
  // bot_payee_map — the SAME memory Claude reads. So next time the same merchant/source appears,
  // Claude proposes this account instead of Suspense. Fires on Approve and on Edit-save, so a
  // correction you make in the app teaches Claude for later. (No income/expense line — e.g. a
  // transfer or a still-Suspense draft — is skipped, so we only learn a real classification.)
  async function rememberPayee(payee, entryIds) {
    if (!payee || !entryIds || !entryIds.length) return
    try {
      const { data: entries } = await supabase.from('journal_entries')
        .select('id, book_id, journal_lines(debit, credit, accounts(id, type))')
        .in('id', entryIds)
      for (const e of entries || []) {
        const cat = (e.journal_lines || [])
          .filter((l) => ['income', 'expense'].includes(l.accounts?.type))
          .map((l) => ({ account_id: l.accounts.id, amt: Math.abs((Number(l.debit) || 0) - (Number(l.credit) || 0)) }))
          .sort((a, b) => b.amt - a.amt)[0]
        if (!cat) continue
        const { data: ex } = await supabase.from('bot_payee_map')
          .select('id, hits').eq('payee', payee).eq('book_id', e.book_id).maybeSingle()
        if (ex) await supabase.from('bot_payee_map')
          .update({ account_id: cat.account_id, hits: (ex.hits || 1) + 1, updated_at: new Date().toISOString() }).eq('id', ex.id)
        else await supabase.from('bot_payee_map')
          .insert({ payee, book_id: e.book_id, account_id: cat.account_id })
      }
    } catch { /* best-effort learning — never block posting */ }
  }

  const pendingCount = drafts.filter((d) => d.status === 'draft').length

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-bold">Statement Inbox</h1>
        <div className="ml-auto flex gap-1 bg-gray-100 rounded-lg p-1">
          {[['drafts', `Drafts${pendingCount ? ` (${pendingCount})` : ''}`], ['recon', 'Reconcile']].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === k ? 'bg-white shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={load} className="text-sm text-gray-500 hover:text-gray-800" title="Refresh">↻</button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-16">Loading…</div>
      ) : tab === 'drafts' ? (
        drafts.length === 0
          ? <Empty>No draft entries yet. In Claude, say “process my pending statements”.</Empty>
          : drafts.map((d) => (
              <DraftCard key={d.id} draft={d} busy={busy === d.id}
                onEdit={() => openEditor(d)}
                onApprove={() => approve(d)} onReject={() => reject(d)} />
            ))
      ) : (
        recon.length === 0
          ? <Empty>No reconcile reports yet.</Empty>
          : recon.map((r) => <ReconCard key={r.id} report={r} onDone={() => markReconDone(r.inbox_id)} />)
      )}
    </div>
  )
}

function Empty({ children }) {
  return <div className="text-center text-gray-400 py-16 border border-dashed border-gray-200 rounded-xl">{children}</div>
}

const CATEGORY_LABEL = {
  fno_net: 'F&O net', intraday_pnl: 'Intraday P&L', delivery_holding: 'Delivery holding',
  alert: 'Alert', other: 'Entry',
}

function DraftCard({ draft, busy, onEdit, onApprove, onReject }) {
  const inbox = draft.stmt_inbox || {}
  const lines = draft.lines || []
  const dr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
  const cr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
  const balanced = Math.abs(dr - cr) < 0.01
  const isDraft = draft.status === 'draft'

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-3">
      <div className="flex flex-wrap items-start gap-2">
        <span className="text-xs bg-brand-50 text-brand-700 rounded-full px-2 py-0.5 font-medium">
          {CATEGORY_LABEL[draft.category] || draft.category || 'entry'}
        </span>
        {inbox.source && <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">{inbox.source}</span>}
        {inbox.kind === 'transaction_alert' && <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">alert</span>}
        {draft.status === 'posted'   && <span className="text-xs rounded-full px-2 py-0.5 bg-green-100 text-green-700">posted</span>}
        {draft.status === 'rejected' && <span className="text-xs rounded-full px-2 py-0.5 bg-red-100 text-red-600">rejected</span>}
      </div>

      <div className="mt-2 text-sm">{draft.narration}</div>
      <div className="text-xs text-gray-400 mt-0.5">
        {draft.entry_date}{draft.reference_no ? ` · ref ${draft.reference_no}` : ''}{inbox.file_name ? ` · ${inbox.file_name}` : ''}
      </div>

      <table className="w-full text-sm mt-3">
        <thead><tr className="text-gray-400 text-xs">
          <th className="text-left font-medium py-1">Account</th>
          <th className="text-right font-medium py-1 w-32">Debit</th>
          <th className="text-right font-medium py-1 w-32">Credit</th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className="border-t border-gray-100">
              <td className="py-1.5">{l.account_name || l.account_id}</td>
              <td className="py-1.5 text-right tabular-nums">{l.debit ? money(l.debit) : ''}</td>
              <td className="py-1.5 text-right tabular-nums">{l.credit ? money(l.credit) : ''}</td>
            </tr>
          ))}
          <tr className="border-t border-gray-200 text-xs">
            <td className={`py-1 ${balanced ? 'text-gray-400' : 'text-red-600 font-medium'}`}>
              {balanced ? 'balanced' : `off by ${money(Math.abs(dr - cr))}`}
            </td>
            <td className="py-1 text-right tabular-nums text-gray-500">{money(dr)}</td>
            <td className="py-1 text-right tabular-nums text-gray-500">{money(cr)}</td>
          </tr>
        </tbody>
      </table>

      {isDraft && (
        <div className="flex gap-2 mt-3">
          <button disabled={busy || !balanced} onClick={onApprove}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-brand-600 text-white disabled:opacity-50">
            {busy ? 'Posting…' : 'Approve & post'}
          </button>
          <button disabled={busy} onClick={onEdit}
            className="px-3 py-1.5 rounded-md text-sm font-medium border border-gray-300 text-gray-700 disabled:opacity-50"
            title="Open the full entry editor pre-filled — change accounts, add a mirror entry, then post">
            Edit…
          </button>
          <button disabled={busy} onClick={onReject}
            className="px-3 py-1.5 rounded-md text-sm font-medium border border-red-300 text-red-600 disabled:opacity-50">
            Reject
          </button>
        </div>
      )}
      {draft.status === 'posted' &&
        <div className="text-xs text-green-600 mt-2">Posted to the ledger.</div>}
    </div>
  )
}

function ReconCard({ report, onDone }) {
  const inbox = report.stmt_inbox || {}
  const miss = report.missing_entries || []
  const bm = report.balance_match === true
    ? <span className="text-green-600">● balance matches</span>
    : report.balance_match === false
      ? <span className="text-red-600">● balance mismatch</span>
      : <span className="text-amber-600">● not checked</span>
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-3">
      <div className="flex items-start gap-2">
        <div>
          <div className="flex gap-2">
            <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">{inbox.kind || ''}</span>
            <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">{inbox.source || ''}</span>
          </div>
          <div className="text-sm mt-1.5">{bm}</div>
          {(report.statement_balance != null || report.book_balance != null) && (
            <div className="text-xs text-gray-400">
              statement {money(report.statement_balance)} vs books {money(report.book_balance)}
              {report.as_of_date ? ` @ ${report.as_of_date}` : ''}
            </div>
          )}
          {report.notes && <div className="text-xs text-gray-500 mt-1">{report.notes}</div>}
        </div>
        <button onClick={onDone}
          className="ml-auto px-3 py-1.5 rounded-md text-sm font-medium border border-gray-300 text-gray-700">
          Mark done
        </button>
      </div>
      <div className="text-xs text-gray-400 mt-3">Missing from books ({miss.length}):</div>
      {miss.length === 0
        ? <div className="text-sm text-gray-500 mt-1">No missing entries — books match. ✅</div>
        : (
          <table className="w-full text-sm mt-1">
            <thead><tr className="text-gray-400 text-xs">
              <th className="text-left font-medium py-1">Date</th>
              <th className="text-left font-medium py-1">Description</th>
              <th className="text-right font-medium py-1">Amount</th>
            </tr></thead>
            <tbody>
              {miss.map((m, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="py-1.5">{m.date || ''}</td>
                  <td className="py-1.5">{m.description || m.narration || ''}</td>
                  <td className="py-1.5 text-right tabular-nums">{m.amount != null ? money(m.amount) : (m.dr_or_cr || '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  )
}
