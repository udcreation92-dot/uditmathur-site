import { supabase } from './supabase'

// A credit card is a liability account whose balance is credit-normal:
//   outstanding (what you owe) = Σ credit − Σ debit
//
// The auto commitment mirrors the STATEMENT balance — the card's outstanding
// as of its most recent statement date (cc_statement_day) — because that fixed
// amount is what the bank actually bills and expects on the due date. If no
// statement day is set we fall back to the live balance.
//
// All credit-card bills are paid from one bank (see CC_PAYMENT_ACCOUNT below),
// so the commitment's paying account/book point there while source_account_id
// still records which card the bill belongs to.

const PAGE = 1000

// The bank every card bill is paid from, resolved by book + account name.
const CC_PAYMENT_ACCOUNT = { book: 'Udit Mathur', account: 'Jana Bank' }

// Most recent statement date on/before today for a given day-of-month.
function lastStatementDate(statementDay) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  let d = new Date(today.getFullYear(), today.getMonth(), statementDay)
  if (d > today) d = new Date(today.getFullYear(), today.getMonth() - 1, statementDay)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Compute the amount still due on a credit card's current statement.
//
//   statement balance = Σ(credit − debit) for lines dated on/before stmtDate
//   payments since    = Σ debit for lines dated after stmtDate (a debit to a
//                       credit-card liability is a payment / credit reducing
//                       what you owe; new purchases are credits and belong to
//                       the NEXT statement, so they're excluded)
//   amount due        = max(0, statement balance − payments since)
//
// When stmtDate is null (no statement day set) we fall back to the full live
// outstanding balance. Paginated — PostgREST caps each response at 1000 rows.
async function cardAmountDue(accountId, stmtDate) {
  let offset = 0
  let stmtDr = 0, stmtCr = 0   // on/before statement date
  let paidAfter = 0            // debits after statement date
  for (;;) {
    const { data, error } = await supabase
      .from('journal_lines')
      .select('debit, credit, journal_entries!inner(date)')
      .eq('account_id', accountId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error || !data) break
    for (const l of data) {
      const dt = l.journal_entries?.date
      if (!stmtDate || dt <= stmtDate) {
        stmtDr += l.debit || 0
        stmtCr += l.credit || 0
      } else {
        paidAfter += l.debit || 0
      }
    }
    if (data.length < PAGE) break
    offset += PAGE
  }
  const statementBalance = stmtCr - stmtDr
  return Math.max(0, statementBalance - paidAfter)
}

/**
 * Reconcile the auto-managed "card bill" commitments so that every credit-card
 * account with a due day has exactly one recurring monthly commitment whose
 * amount equals its statement balance, due on cc_due_day, paid from the shared
 * credit-card payment bank.
 *
 * Returns the number of commitments created/updated.
 */
export async function syncCreditCardCommitments() {
  const [{ data: settings }, { data: accounts }, { data: existingAuto }] = await Promise.all([
    supabase.from('account_settings').select('account_id, account_role, cc_statement_day, cc_due_day'),
    supabase.from('accounts').select('id, name, book_id, type, books(name)'),
    supabase.from('commitments')
      .select('id, source_account_id, account_id, book_id, amount, is_active, recurrence, description')
      .eq('is_auto', true),
  ])

  const acctMap = Object.fromEntries((accounts || []).map(a => [a.id, a]))
  const autoMap = Object.fromEntries((existingAuto || []).map(c => [c.source_account_id, c]))

  // Resolve the shared bank that all card bills are paid from.
  const payAcct = (accounts || []).find(
    a => a.books?.name === CC_PAYMENT_ACCOUNT.book && a.name === CC_PAYMENT_ACCOUNT.account,
  )

  const cards = (settings || []).filter(s => s.account_role === 'credit_card')
  const keepIds = new Set()
  let touched = 0

  for (const s of cards) {
    const card = acctMap[s.account_id]
    if (!card) continue
    const dueDay = Number(s.cc_due_day)
    if (!dueDay || dueDay < 1 || dueDay > 28) continue   // no due day → no auto commitment

    const stmtDay = Number(s.cc_statement_day)
    const asOf = stmtDay >= 1 && stmtDay <= 28 ? lastStatementDate(stmtDay) : null

    const due = await cardAmountDue(s.account_id, asOf)
    if (due <= 0.005) continue   // statement fully paid (or nothing billed) → no commitment

    const amount = Math.round(due * 100) / 100
    const recurrence = { freq: 'monthly', day: dueDay }
    const description = `${card.name} — Card bill (auto)`
    // Pay from the shared bank if resolved; otherwise fall back to the card.
    const payId   = payAcct?.id      || s.account_id
    const payBook = payAcct?.book_id || card.book_id

    const existing = autoMap[s.account_id]
    if (existing) {
      keepIds.add(existing.id)
      const changed =
        Math.abs((existing.amount || 0) - amount) > 0.005 ||
        existing.recurrence?.day !== dueDay ||
        existing.account_id !== payId ||
        existing.book_id !== payBook ||
        existing.description !== description
      if (changed) {
        await supabase.from('commitments').update({
          amount, recurrence, description, account_id: payId, book_id: payBook,
        }).eq('id', existing.id)
        touched++
      }
    } else {
      const { data: ins } = await supabase.from('commitments').insert({
        book_id:           payBook,
        account_id:        payId,
        source_account_id: s.account_id,
        description,
        amount,
        commitment_type:   'recurring',
        recurrence,
        is_auto:           true,
        is_active:         true,
      }).select('id').single()
      if (ins) keepIds.add(ins.id)
      touched++
    }
  }

  // Remove stale auto commitments (card no longer qualifies).
  const stale = (existingAuto || []).filter(c => !keepIds.has(c.id)).map(c => c.id)
  if (stale.length) {
    await supabase.from('commitments').delete().in('id', stale)
  }

  return touched
}
