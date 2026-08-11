import { supabase } from './supabase'

// A credit card is a liability account whose balance is credit-normal:
//   outstanding (what you owe) = Σ credit − Σ debit
// The auto commitment mirrors this live balance, due monthly on cc_due_day.

const PAGE = 1000

// Sum a single account's debit/credit across all lines (paginated — PostgREST
// caps each response at 1000 rows).
async function accountDrCr(accountId) {
  let offset = 0, dr = 0, cr = 0
  for (;;) {
    const { data, error } = await supabase
      .from('journal_lines')
      .select('debit, credit')
      .eq('account_id', accountId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error || !data) break
    for (const l of data) { dr += l.debit || 0; cr += l.credit || 0 }
    if (data.length < PAGE) break
    offset += PAGE
  }
  return { dr, cr }
}

/**
 * Reconcile the auto-managed "card bill" commitments so that every credit-card
 * account with a due day has exactly one recurring monthly commitment whose
 * amount equals its current outstanding balance, due on cc_due_day.
 *
 * - No due day, or nothing owed → the auto commitment is removed.
 * - Fully managed: amount + schedule are overwritten to match live data on
 *   every sync. Users may pause it (is_active), which is preserved.
 *
 * Returns the number of commitments created/updated.
 */
export async function syncCreditCardCommitments() {
  const [{ data: settings }, { data: accounts }, { data: existingAuto }] = await Promise.all([
    supabase.from('account_settings').select('account_id, account_role, cc_due_day'),
    supabase.from('accounts').select('id, name, book_id, type'),
    supabase.from('commitments').select('id, source_account_id, amount, is_active, recurrence').eq('is_auto', true),
  ])

  const acctMap = Object.fromEntries((accounts || []).map(a => [a.id, a]))
  const autoMap = Object.fromEntries((existingAuto || []).map(c => [c.source_account_id, c]))

  const cards = (settings || []).filter(s => s.account_role === 'credit_card')
  const keepIds = new Set()
  let touched = 0

  for (const s of cards) {
    const acct = acctMap[s.account_id]
    if (!acct) continue
    const dueDay = Number(s.cc_due_day)
    const existing = autoMap[s.account_id]

    // No due day configured → drop any auto commitment for this card.
    if (!dueDay || dueDay < 1 || dueDay > 28) continue

    const { dr, cr } = await accountDrCr(s.account_id)
    const outstanding = cr - dr

    // Nothing owed → drop the auto commitment (it'll regenerate when a balance returns).
    if (outstanding <= 0.005) continue

    const amount = Math.round(outstanding * 100) / 100
    const recurrence = { freq: 'monthly', day: dueDay }

    if (existing) {
      keepIds.add(existing.id)
      const drift = Math.abs((existing.amount || 0) - amount) > 0.005
      const schedChanged = existing.recurrence?.day !== dueDay
      if (drift || schedChanged) {
        await supabase.from('commitments').update({
          amount,
          recurrence,
          description: `${acct.name} — Card bill (auto)`,
          book_id: acct.book_id,
        }).eq('id', existing.id)
        touched++
      }
    } else {
      const { data: ins } = await supabase.from('commitments').insert({
        book_id:         acct.book_id,
        account_id:      s.account_id,
        source_account_id: s.account_id,
        description:     `${acct.name} — Card bill (auto)`,
        amount,
        commitment_type: 'recurring',
        recurrence,
        is_auto:         true,
        is_active:       true,
      }).select('id').single()
      if (ins) keepIds.add(ins.id)
      touched++
    }
  }

  // Remove stale auto commitments (card no longer qualifies: role changed,
  // due day cleared, or balance cleared).
  const stale = (existingAuto || []).filter(c => !keepIds.has(c.id)).map(c => c.id)
  if (stale.length) {
    await supabase.from('commitments').delete().in('id', stale)
  }

  return touched
}
