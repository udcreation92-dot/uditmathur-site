// Matches extracted statement transactions against the ledger for one account.
// Matching is done in code (amount + date proximity), never by the LLM, so the
// reconciliation is deterministic and trustworthy.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { StatementTxn } from "./gemini.ts";

const DATE_TOLERANCE_DAYS = 4;

const money = (n: number) =>
  `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface LedgerLine { date: string; amount: number; narration: string }

export interface ReconcileResult {
  matched: number;
  missingInLedger: StatementTxn[]; // on statement, not in ledger
  extraInLedger: LedgerLine[]; // in ledger, not on statement
  report: string;
}

function daysApart(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

export async function reconcile(
  sb: SupabaseClient,
  accountId: string,
  accountName: string,
  txns: StatementTxn[],
): Promise<ReconcileResult> {
  // Pull this account's ledger lines within the statement's date span (± buffer).
  const dates = txns.map((t) => t.date).filter(Boolean).sort();
  const from = dates.length ? shift(dates[0], -DATE_TOLERANCE_DAYS) : "1900-01-01";
  const to = dates.length ? shift(dates[dates.length - 1], DATE_TOLERANCE_DAYS) : "2999-01-01";

  const { data: rows } = await sb
    .from("journal_lines")
    .select("debit, credit, journal_entries(date, narration)")
    .eq("account_id", accountId);

  // Filter to the statement's date span in code (robust vs embedded filters).
  const ledger: (LedgerLine & { used?: boolean })[] = (rows ?? [])
    .map((r: any) => ({
      date: r.journal_entries?.date ?? "1900-01-01",
      amount: Math.abs((r.debit || 0) - (r.credit || 0)),
      narration: r.journal_entries?.narration ?? "",
    }))
    .filter((l) => l.date >= from && l.date <= to);

  const missingInLedger: StatementTxn[] = [];
  let matched = 0;

  for (const t of txns) {
    // Find an unused ledger line with the same amount, closest date within tolerance.
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < ledger.length; i++) {
      if (ledger[i].used) continue;
      if (Math.abs(ledger[i].amount - t.amount) >= 0.01) continue;
      const d = daysApart(ledger[i].date, t.date);
      if (d <= DATE_TOLERANCE_DAYS && d < bestDist) { best = i; bestDist = d; }
    }
    if (best >= 0) { ledger[best].used = true; matched++; }
    else missingInLedger.push(t);
  }

  const extraInLedger = ledger.filter((l) => !l.used);

  // Build the human report.
  const lines: string[] = [`*Reconciliation — ${accountName}*`];
  lines.push(`Checked ${txns.length} statement line(s): ✅ ${matched} matched.`);

  const CAP = 15; // keep the message under Telegram's length limit
  if (missingInLedger.length) {
    lines.push(`\n⚠️ *On statement, missing from ledger (${missingInLedger.length}):*`);
    missingInLedger.slice(0, CAP).forEach((t, i) =>
      lines.push(`  ${i + 1}. ${t.date} — ${money(t.amount)} ${t.direction} — ${t.description}`)
    );
    if (missingInLedger.length > CAP) lines.push(`  …and ${missingInLedger.length - CAP} more`);
  }
  if (extraInLedger.length) {
    lines.push(`\n⚠️ *In ledger, not on this statement (${extraInLedger.length}):*`);
    extraInLedger.slice(0, CAP).forEach((l, i) =>
      lines.push(`  ${i + 1}. ${l.date} — ${money(l.amount)} — ${l.narration}`)
    );
    if (extraInLedger.length > CAP) lines.push(`  …and ${extraInLedger.length - CAP} more`);
  }
  if (!missingInLedger.length && !extraInLedger.length) {
    lines.push("\n✅ *All checked* — everything ties out.");
  }

  return { matched, missingInLedger, extraInLedger, report: lines.join("\n") };
}

function shift(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86400000).toISOString().slice(0, 10);
}
