// Computes an exact financial snapshot from the ledger, so the Q&A agent only
// has to READ figures and phrase them — never do arithmetic on raw rows.
//
// Produces, per book: each account's current balance and (for asset accounts)
// the current-month average daily balance; type subtotals; and MAB requirement
// + shortfall where set in bot_account_meta.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

interface Row {
  account_id: string;
  debit: number;
  credit: number;
  date: string;
}

const money = (n: number) =>
  `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Time-weighted average of daily closing balance for the current month (MAB style).
function monthAverage(rows: Row[]): number {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const msISO = monthStart.toISOString().slice(0, 10);
  const todayISO = now.toISOString().slice(0, 10);

  // Opening balance = net of everything before this month.
  let balance = 0;
  const deltasByDay = new Map<string, number>();
  for (const r of rows) {
    const net = (r.debit || 0) - (r.credit || 0);
    if (r.date < msISO) balance += net;
    else deltasByDay.set(r.date, (deltasByDay.get(r.date) ?? 0) + net);
  }

  const days = Math.max(
    1,
    Math.round((now.getTime() - monthStart.getTime()) / 86400000) + 1,
  );
  let sum = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(monthStart.getTime() + i * 86400000).toISOString().slice(0, 10);
    if (d > todayISO) break;
    balance += deltasByDay.get(d) ?? 0;
    sum += balance;
  }
  return sum / days;
}

export async function buildSnapshot(sb: SupabaseClient): Promise<string> {
  const [{ data: books }, { data: accounts }, { data: lines }, { data: metas }] = await Promise.all([
    sb.from("books").select("id, name").order("name"),
    sb.from("accounts").select("id, book_id, name, type"),
    sb.from("journal_lines").select("account_id, debit, credit, journal_entries(date)"),
    sb.from("bot_account_meta").select("account_id, min_balance, note"),
  ]);

  // Group lines by account.
  const byAccount = new Map<string, Row[]>();
  for (const l of lines ?? []) {
    const date = (l as any).journal_entries?.date ?? "1970-01-01";
    const arr = byAccount.get(l.account_id) ?? [];
    arr.push({ account_id: l.account_id, debit: l.debit, credit: l.credit, date });
    byAccount.set(l.account_id, arr);
  }
  const metaMap = new Map((metas ?? []).map((m: any) => [m.account_id, m]));

  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [`FINANCIAL SNAPSHOT (as of ${today}). All figures exact from the ledger.`];

  for (const b of books ?? []) {
    const accts = (accounts ?? []).filter((a) => a.book_id === b.id);
    out.push(`\nBOOK "${b.name}":`);
    const typeTotals: Record<string, number> = {};

    for (const a of accts) {
      const rows = byAccount.get(a.id) ?? [];
      const bal = rows.reduce((s, r) => s + (r.debit || 0) - (r.credit || 0), 0);
      typeTotals[a.type] = (typeTotals[a.type] ?? 0) + bal;

      // For assets/liabilities, a positive Dr balance is normal for assets.
      const sign = bal >= 0 ? "Dr" : "Cr";
      let line = `  - "${a.name}" [${a.type}]: ${money(Math.abs(bal))} ${sign}`;

      if (a.type === "asset" && rows.length) {
        line += ` | this-month avg ${money(monthAverage(rows))}`;
      }
      const meta = metaMap.get(a.id) as any;
      if (meta?.min_balance != null) {
        const avg = a.type === "asset" ? monthAverage(rows) : bal;
        const shortfall = Number(meta.min_balance) - avg;
        line += ` | MAB required ${money(meta.min_balance)}` +
          (shortfall > 0 ? ` — SHORTFALL ${money(shortfall)}` : ` — OK (surplus ${money(-shortfall)})`);
      }
      if (meta?.note) line += ` | note: ${meta.note}`;
      out.push(line);
    }

    const totalsStr = Object.entries(typeTotals)
      .map(([t, v]) => `${t}=${money(v)}`).join(", ");
    if (totalsStr) out.push(`  Subtotals: ${totalsStr}`);
  }

  return out.join("\n");
}
