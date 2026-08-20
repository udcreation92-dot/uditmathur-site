// Turns a confirmed draft into real rows: creates any approved new accounts,
// inserts journal_entries + balanced journal_lines, and attaches the SHARED
// voucher image(s) to every entry. Runs only after the owner taps Confirm.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AgentEntry } from "./gemini.ts";
import { DriveFile } from "./drive.ts";

const money = (n: number) =>
  `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function validateEntries(entries: AgentEntry[]): string | null {
  if (!entries.length) return "No entries to post.";
  for (const [i, e] of entries.entries()) {
    if (!e.book_id) return `Entry ${i + 1}: missing book.`;
    if (!e.lines?.length || e.lines.length < 2) return `Entry ${i + 1}: needs at least two lines.`;
    const dr = e.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const cr = e.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(dr - cr) >= 0.01) {
      return `Entry ${i + 1} does not balance (Dr ${money(dr)} vs Cr ${money(cr)}).`;
    }
    if (dr <= 0) return `Entry ${i + 1}: total is zero.`;
  }
  return null;
}

export interface PostResult { entryIds: string[] }

export async function postEntries(
  sb: SupabaseClient,
  entries: AgentEntry[],
  driveFiles: DriveFile[],
): Promise<PostResult> {
  const entryIds: string[] = [];

  for (const e of entries) {
    // 1. Resolve any approved new_account lines into real account ids.
    const resolvedLines: { account_id: string; debit: number; credit: number }[] = [];
    for (const l of e.lines) {
      let accountId = l.account_id;
      if (!accountId && l.new_account) {
        const { data, error } = await sb
          .from("accounts")
          .insert({
            book_id: l.new_account.book_id,
            name: l.new_account.name,
            type: l.new_account.type,
          })
          .select("id")
          .single();
        if (error) throw new Error(`create account "${l.new_account.name}": ${error.message}`);
        accountId = data.id;
      }
      if (!accountId) throw new Error("A line has neither account_id nor new_account.");
      resolvedLines.push({
        account_id: accountId,
        debit: Number(l.debit) || 0,
        credit: Number(l.credit) || 0,
      });
    }

    // 2. Journal entry header.
    const { data: entry, error: eErr } = await sb
      .from("journal_entries")
      .insert({
        book_id: e.book_id,
        date: e.date,
        narration: e.narration,
        reference_no: e.reference_no || null,
      })
      .select("id")
      .single();
    if (eErr) throw new Error(`create entry: ${eErr.message}`);

    // 3. Lines.
    const { error: lErr } = await sb
      .from("journal_lines")
      .insert(resolvedLines.map((l) => ({ ...l, entry_id: entry.id })));
    if (lErr) throw new Error(`create lines: ${lErr.message}`);

    // 4. Attach the shared voucher(s) to THIS entry (one row per file per entry).
    if (driveFiles.length) {
      const { error: aErr } = await sb.from("attachments").insert(
        driveFiles.map((f) => ({
          entry_id: entry.id,
          drive_file_id: f.id,
          file_name: f.name,
          mime_type: f.mimeType,
          web_view_link: f.webViewLink,
        })),
      );
      if (aErr) throw new Error(`attach voucher: ${aErr.message}`);
    }

    // 5. Remember the payee -> category account mapping so we stop re-asking.
    await rememberPayee(sb, e, resolvedLines);

    entryIds.push(entry.id);
  }

  return { entryIds };
}

// Upsert bot_payee_map from a posted entry, incrementing hits on repeats.
async function rememberPayee(
  sb: SupabaseClient,
  e: AgentEntry,
  resolvedLines: { account_id: string; debit: number; credit: number }[],
) {
  const payee = (e.payee ?? "").trim();
  const idx = e.category_line_index;
  if (!payee || idx == null || idx < 0 || idx >= resolvedLines.length) return;
  const accountId = resolvedLines[idx].account_id;
  if (!accountId) return;

  try {
    const { data: existing } = await sb
      .from("bot_payee_map")
      .select("id, hits")
      .eq("payee", payee)
      .eq("book_id", e.book_id)
      .maybeSingle();
    if (existing) {
      await sb.from("bot_payee_map")
        .update({ account_id: accountId, hits: (existing.hits ?? 1) + 1 })
        .eq("id", existing.id);
    } else {
      await sb.from("bot_payee_map")
        .insert({ payee, book_id: e.book_id, account_id: accountId });
    }
  } catch { /* memory is best-effort; never block a posted entry */ }
}
