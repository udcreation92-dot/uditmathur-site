// Accounts Telegram bot webhook.
//
// Flow: forward payment screenshot(s) -> bot reads them with Gemini and proposes
// the journal entry/entries -> you answer any questions in chat -> /done -> tap
// ✅ Confirm -> entries + attachments are written to the SAME Supabase the web
// app reads, so they appear instantly in the ledger.
//
// Nothing is ever posted without an explicit Confirm tap (real money).

import { db } from "../_shared/db.ts";
import {
  answerCallbackQuery,
  downloadFile,
  sendChatAction,
  sendMessage,
} from "../_shared/telegram.ts";
import { AccountsContext, loadContext, renderContext } from "../_shared/context.ts";
import { AgentEntry, extractStatement, runAgent, runQuery } from "../_shared/gemini.ts";
import { buildSnapshot } from "../_shared/reports.ts";
import { StoredFile, uploadVoucher } from "../_shared/storage.ts";
import { postEntries, validateEntries } from "../_shared/poster.ts";
import {
  decryptToUnprotected,
  extractPdfText,
  isPasswordError,
  PdfPassword,
  tryReadPdf,
} from "../_shared/pdf.ts";
import { reconcile } from "../_shared/reconcile.ts";
import { StatementTxn } from "../_shared/gemini.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const ALLOWED = (Deno.env.get("ALLOWED_CHAT_IDS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ADD_BATCH = 8; // how many missing entries /addmissing proposes per batch

const todayISO = () => new Date().toISOString().slice(0, 10);
const money = (n: number) =>
  `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── draft helpers ────────────────────────────────────────────────────────────

async function getOpenDraft(sb: ReturnType<typeof db>, chatId: number) {
  const { data } = await sb
    .from("bot_pending_txn")
    .select("*")
    .eq("telegram_chat_id", chatId)
    .in("status", ["collecting", "awaiting_confirm"])
    .maybeSingle();
  return data;
}

async function getOrCreateDraft(sb: ReturnType<typeof db>, chatId: number) {
  const existing = await getOpenDraft(sb, chatId);
  if (existing) return existing;
  const { data } = await sb
    .from("bot_pending_txn")
    .insert({ telegram_chat_id: chatId })
    .select("*")
    .single();
  return data;
}

// Render the proposed entries into a readable Telegram message using account names.
function renderDraft(entries: AgentEntry[], ctx: AccountsContext, questions: string[]): string {
  const bookName = (id: string) => ctx.books.find((b) => b.id === id)?.name ?? "?";
  const acctName = (id?: string) => ctx.accounts.find((a) => a.id === id)?.name;

  const blocks = entries.map((e, i) => {
    const lines = e.lines.map((l) => {
      const name = l.account_id
        ? (acctName(l.account_id) ?? "unknown account")
        : `🆕 ${l.new_account?.name} (new ${l.new_account?.type})`;
      const side = (l.debit || 0) > 0 ? `Dr ${money(l.debit)}` : `Cr ${money(l.credit)}`;
      return `    • ${name} — ${side}`;
    }).join("\n");
    return `*Entry ${i + 1} — ${bookName(e.book_id)}* (${e.date})\n_${e.narration}_${
      e.reference_no ? `  ·  ref ${e.reference_no}` : ""
    }\n${lines}`;
  }).join("\n\n");

  const q = questions.length
    ? `\n\n❓ *I need to know:*\n${questions.map((x) => `• ${x}`).join("\n")}`
    : "";
  return `${blocks || "_(no entries yet)_"}${q}`;
}

async function runAndReply(
  sb: ReturnType<typeof db>,
  chatId: number,
  draft: any,
  ctx: AccountsContext,
) {
  // Re-download every image in this draft so Gemini sees them all together.
  const images: { bytes: Uint8Array; mime: string }[] = [];
  for (const img of draft.images ?? []) {
    try {
      const f = await downloadFile(img.telegram_file_id);
      images.push({ bytes: f.bytes, mime: f.mime });
    } catch { /* skip a file that expired; user can re-send */ }
  }

  const docTexts: string[] = (draft.pending?.pdfDocs ?? []).map((d: any) => d.text).filter(Boolean);

  const result = await runAgent(
    renderContext(ctx),
    images,
    draft.conversation ?? [],
    todayISO(),
    docTexts,
  );

  await sb.from("bot_pending_txn").update({
    entries: result.entries,
    open_questions: result.questions,
    conversation: [...(draft.conversation ?? []), { role: "bot", text: result.summary }],
  }).eq("id", draft.id);

  const body = renderDraft(result.entries, ctx, result.questions);
  const footer = result.ready
    ? "\n\n✅ Looks complete. Send /done to review & post."
    : "\n\nReply with answers, send more screenshots, or /done when ready.";
  await sendMessage(chatId, `${body}${footer}`);
}

// ── confirm (post) ───────────────────────────────────────────────────────────

async function confirmAndPost(sb: ReturnType<typeof db>, chatId: number, draftId: string) {
  const { data: draft } = await sb.from("bot_pending_txn").select("*").eq("id", draftId).single();
  if (!draft || draft.status === "posted") {
    await sendMessage(chatId, "That draft is no longer active.");
    return;
  }

  const entries = draft.entries as AgentEntry[];
  const invalid = validateEntries(entries);
  if (invalid) {
    await sendMessage(chatId, `⚠️ Can't post: ${invalid}\nReply to fix, or /cancel.`);
    return;
  }

  await sendChatAction(chatId, "upload_document");

  // Upload each shared screenshot to storage once; attach to every entry.
  const driveFiles: StoredFile[] = [];
  for (const img of draft.images ?? []) {
    try {
      const f = await downloadFile(img.telegram_file_id);
      const name = `voucher_${draft.id.slice(0, 8)}_${driveFiles.length + 1}.${
        f.mime.split("/")[1] ?? "jpg"
      }`;
      driveFiles.push(await uploadVoucher(sb, f.bytes, name, f.mime));
    } catch (e) {
      await sendMessage(chatId, `⚠️ Voucher upload failed (${String(e)}). Posting without it.`);
    }
  }

  // Attach any PDF documents (contract notes) — decrypted copy where possible.
  for (const pdf of draft.pending?.pdfDocs ?? []) {
    try {
      const f = await downloadFile(pdf.telegram_file_id);
      const unlocked = pdf.password ? await decryptToUnprotected(f.bytes, pdf.password) : null;
      const bytes = unlocked ?? f.bytes; // fall back to original if decrypt unavailable
      const name = `document_${draft.id.slice(0, 8)}_${driveFiles.length + 1}.pdf`;
      driveFiles.push(await uploadVoucher(sb, bytes, name, "application/pdf"));
    } catch (e) {
      await sendMessage(chatId, `⚠️ Document attach failed (${String(e)}). Posting without it.`);
    }
  }

  const { entryIds } = await postEntries(sb, entries, driveFiles);
  await sb.from("bot_pending_txn").update({ status: "posted" }).eq("id", draft.id);

  const voucherLinks = driveFiles
    .filter((f) => f.webViewLink)
    .map((f, i) => `[🖼 View voucher${driveFiles.length > 1 ? " " + (i + 1) : ""}](${f.webViewLink})`)
    .join("   ");

  await sendMessage(
    chatId,
    `✅ Posted ${entryIds.length} entr${entryIds.length > 1 ? "ies" : "y"}${
      driveFiles.length ? `, ${driveFiles.length} voucher(s) attached` : ""
    }. They're in your ledger now.${voucherLinks ? "\n\n" + voucherLinks : ""}`,
  );
}

// ── Q&A mode ─────────────────────────────────────────────────────────────────

async function handleQuery(sb: ReturnType<typeof db>, chatId: number, question: string) {
  if (!question.trim()) {
    await sendMessage(
      chatId,
      'Ask me about your accounts — e.g. _"balance of Jana Bank in Udit"_, _"liabilities of MAAPL"_, _"this month average of AU bank"_. To record a minimum balance: _"set AU bank minimum to 25000"_.',
    );
    return;
  }
  await sendChatAction(chatId, "typing");
  const snapshot = await buildSnapshot(sb);
  const res = await runQuery(snapshot, question);

  if (res.set_min?.account_id) {
    await sb.from("bot_account_meta").upsert(
      { account_id: res.set_min.account_id, min_balance: res.set_min.amount },
      { onConflict: "account_id" },
    );
  }
  await sendMessage(chatId, res.answer || "I couldn't work that out from your ledger.");
}

// ── locked-PDF handling ──────────────────────────────────────────────────────

async function loadPdfPasswords(sb: ReturnType<typeof db>): Promise<PdfPassword[]> {
  const { data } = await sb.from("bot_pdf_passwords")
    .select("label, password").order("hits", { ascending: false });
  return (data ?? []) as PdfPassword[];
}

async function bumpPdfPassword(sb: ReturnType<typeof db>, label: string) {
  const { data } = await sb.from("bot_pdf_passwords").select("hits").eq("label", label).maybeSingle();
  if (data) await sb.from("bot_pdf_passwords").update({ hits: (data.hits ?? 0) + 1 }).eq("label", label);
}

// Append an unlocked/plain PDF's info + extracted text to the draft's pending payload.
async function addPdfDocToDraft(
  sb: ReturnType<typeof db>,
  draft: any,
  file: { file_id: string; file_unique_id: string },
  password: string | null,
  label: string | null,
  text: string,
  caption: string,
) {
  const pdfDocs = [...(draft.pending?.pdfDocs ?? [])];
  if (!pdfDocs.some((d: any) => d.file_unique_id === file.file_unique_id)) {
    pdfDocs.push({ telegram_file_id: file.file_id, file_unique_id: file.file_unique_id, password, label, text });
  }
  const pending = { ...(draft.pending ?? {}), pdfDocs };
  const conversation = caption
    ? [...(draft.conversation ?? []), { role: "user", text: caption }]
    : draft.conversation;
  await sb.from("bot_pending_txn").update({ pending, conversation }).eq("id", draft.id);
  draft.pending = pending;
  draft.conversation = conversation;
}

async function handlePdfDoc(
  sb: ReturnType<typeof db>,
  chatId: number,
  draft: any,
  ctx: AccountsContext,
  pdfDoc: any,
  caption: string,
) {
  const f = await downloadFile(pdfDoc.file_id);
  const saved = await loadPdfPasswords(sb);
  const res = await tryReadPdf(f.bytes, saved);

  if (!res) {
    await sb.from("bot_pending_txn").update({
      awaiting: "pdf_password",
      pending: {
        ...(draft.pending ?? {}),
        lockedPdf: { telegram_file_id: pdfDoc.file_id, file_unique_id: pdfDoc.file_unique_id },
      },
    }).eq("id", draft.id);
    await sendMessage(
      chatId,
      "🔒 This PDF is password-protected and none of my saved passwords opened it.\nReply with the password. To remember it for this *kind* of document, send: `password | Label`  (e.g. `ABCDE1234F | Zerodha contract note`).",
    );
    return;
  }

  if (res.label) await bumpPdfPassword(sb, res.label);
  await addPdfDocToDraft(sb, draft, pdfDoc, res.password, res.label, res.text, caption);
  await sendMessage(
    chatId,
    `${res.label ? `🔓 Opened with saved password (_${res.label}_).` : "📄 Read the document."} (${res.text.length} chars)`,
  );
  await runAndReply(sb, chatId, draft, ctx);
}

// User replied with a password for a locked PDF (record OR reconcile).
async function handlePasswordReply(
  sb: ReturnType<typeof db>,
  chatId: number,
  draft: any,
  text: string,
  ctx: AccountsContext,
) {
  const locked = draft.pending?.lockedPdf;
  if (!locked) {
    await sb.from("bot_pending_txn").update({ awaiting: null }).eq("id", draft.id);
    return;
  }
  const [pwPart, labelPart] = text.split("|").map((s) => s.trim());
  const password = pwPart;
  const f = await downloadFile(locked.telegram_file_id);

  let content: string;
  try {
    content = await extractPdfText(f.bytes, password);
  } catch (e) {
    if (isPasswordError(e)) {
      await sendMessage(chatId, "❌ That password didn't work. Try again, or /cancel.");
      return;
    }
    throw e;
  }

  const label = labelPart || `Document ${todayISO()}`;
  await sb.from("bot_pdf_passwords").upsert({ label, password }, { onConflict: "label" });
  await sendMessage(
    chatId,
    (labelPart
      ? `🔓 Unlocked. Saved this password as "${label}" — I won't ask again for this kind.`
      : "🔓 Unlocked.") + ` (${content.length} chars read)`,
  );

  // Clear the await, then continue as record or reconcile.
  await sb.from("bot_pending_txn").update({ awaiting: null }).eq("id", draft.id);
  const { data: fresh } = await sb.from("bot_pending_txn").select("*").eq("id", draft.id).single();

  if (fresh.mode === "reconcile") {
    await runStatementFromText(sb, chatId, fresh, ctx, content);
  } else {
    await addPdfDocToDraft(
      sb, fresh, { file_id: locked.telegram_file_id, file_unique_id: locked.file_unique_id },
      password, label, content, "",
    );
    await runAndReply(sb, chatId, fresh, ctx);
  }
}

// ── reconciliation ───────────────────────────────────────────────────────────

// Find the ledger account a statement belongs to, from its source hint.
async function resolveStatementAccount(
  sb: ReturnType<typeof db>,
  ctx: AccountsContext,
  hint: string | null,
): Promise<{ book_id: string; account_id: string; name: string } | null> {
  // Remembered mapping first.
  if (hint) {
    const { data: mapped } = await sb.from("bot_stmt_account_map")
      .select("book_id, account_id, accounts(name)").eq("source", hint).maybeSingle();
    if (mapped) {
      return { book_id: mapped.book_id, account_id: mapped.account_id, name: (mapped as any).accounts?.name ?? hint };
    }
    // Fuzzy: match hint words against account names.
    const words = hint.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const hit = ctx.accounts.find((a) =>
      words.some((w) => a.name.toLowerCase().includes(w))
    );
    if (hit) return { book_id: hit.book_id, account_id: hit.id, name: hit.name };
  }
  return null;
}

async function runStatement(
  sb: ReturnType<typeof db>,
  chatId: number,
  draft: any,
  ctx: AccountsContext,
  images: { bytes: Uint8Array; mime: string }[],
  docText: string | null,
) {
  await sendMessage(chatId, "🔍 Reading the statement…");
  await sendChatAction(chatId, "typing");
  const extract = await extractStatement(images, docText);
  if (!extract.transactions.length) {
    await sendMessage(chatId, "I couldn't read any transactions from that statement.");
    return;
  }
  await sendMessage(chatId, `Read ${extract.transactions.length} transactions. Matching against your ledger…`);

  const resolved = await resolveStatementAccount(sb, ctx, extract.source_hint);
  if (!resolved) {
    await sb.from("bot_pending_txn").update({
      awaiting: "reconcile_account",
      pending: { ...(draft.pending ?? {}), statement: extract },
    }).eq("id", draft.id);
    await sendMessage(
      chatId,
      `Read ${extract.transactions.length} transactions${
        extract.source_hint ? ` (looks like *${extract.source_hint}*)` : ""
      }, but I'm not sure which ledger account this is.\nReply *Book / Account* — e.g. \`Udit / HDFC Credit Card\`.`,
    );
    return;
  }
  await runReconcileAndReport(sb, chatId, draft, resolved, extract.transactions, extract.source_hint);
}

async function runStatementFromText(
  sb: ReturnType<typeof db>, chatId: number, draft: any, ctx: AccountsContext, docText: string,
) {
  await runStatement(sb, chatId, draft, ctx, [], docText);
}

async function runReconcileAndReport(
  sb: ReturnType<typeof db>,
  chatId: number,
  draft: any,
  target: { book_id: string; account_id: string; name: string },
  txns: StatementTxn[],
  sourceHint: string | null,
) {
  const result = await reconcile(sb, target.account_id, target.name, txns);

  // Remember the account for this statement source.
  if (sourceHint) {
    await sb.from("bot_stmt_account_map").upsert(
      { source: sourceHint, book_id: target.book_id, account_id: target.account_id },
      { onConflict: "source" },
    );
  }

  // Reconcile session is done; close its draft. The missing lines go into a
  // separate queue so /addmissing can create them in small batches.
  await sb.from("bot_pending_txn").update({ status: "cancelled" }).eq("id", draft.id);

  let footer = "";
  if (result.missingInLedger.length) {
    await sb.from("bot_reconcile_queue").upsert(
      { telegram_chat_id: chatId, target, missing: result.missingInLedger, processed: 0 },
      { onConflict: "telegram_chat_id" },
    );
    footer = `\n\nSend /addmissing to create the ${result.missingInLedger.length} missing entr${
      result.missingInLedger.length > 1 ? "ies" : "y"
    } in batches of ${ADD_BATCH} — each batch gets its own review & ✅ Confirm.`;
  } else {
    await sb.from("bot_reconcile_queue").delete().eq("telegram_chat_id", chatId);
  }
  await sendMessage(chatId, result.report + footer);
}

// Hand out the next batch of missing statement lines as a record draft to confirm.
async function handleAddMissing(
  sb: ReturnType<typeof db>, chatId: number, ctx: AccountsContext,
) {
  const { data: q } = await sb.from("bot_reconcile_queue")
    .select("*").eq("telegram_chat_id", chatId).maybeSingle();
  if (!q) {
    await sendMessage(chatId, "Nothing to add. Run /check on a statement first.");
    return;
  }
  const missing = (q.missing ?? []) as StatementTxn[];
  const target = q.target as { book_id: string; account_id: string; name: string };
  const start = q.processed ?? 0;

  if (start >= missing.length) {
    await sb.from("bot_reconcile_queue").delete().eq("telegram_chat_id", chatId);
    await sendMessage(chatId, "✅ All missing entries have been handled.");
    return;
  }

  const batch = missing.slice(start, start + ADD_BATCH);
  const done = start + batch.length;
  const remaining = missing.length - done;
  await sb.from("bot_reconcile_queue").update({ processed: done }).eq("telegram_chat_id", chatId);

  // Fresh record draft for this batch (cancel any existing open draft first).
  const existing = await getOpenDraft(sb, chatId);
  if (existing) await sb.from("bot_pending_txn").update({ status: "cancelled" }).eq("id", existing.id);

  const lines = batch.map((t) =>
    `- ${t.date}: ${t.direction} ₹${t.amount} — ${t.description}`
  ).join("\n");
  const instruction =
    `Create journal entries to record these ${batch.length} transactions from a statement for account "${target.name}" (account_id ${target.account_id}). ` +
    `Each should hit that account plus the correct counterparty account. Ask if a counterparty is unclear.\n${lines}`;

  const { data: fresh } = await sb.from("bot_pending_txn")
    .insert({ telegram_chat_id: chatId, mode: "record", conversation: [{ role: "user", text: instruction }] })
    .select("*").single();

  await sendMessage(
    chatId,
    `📦 *Batch ${start + 1}–${done} of ${missing.length}.* Proposing entries — review, then /done → ✅ Confirm.` +
      (remaining > 0 ? `\nAfter posting, send /addmissing again for the next ${Math.min(ADD_BATCH, remaining)} (${remaining} left).` : `\n(This is the last batch.)`),
  );
  await runAndReply(sb, chatId, fresh, ctx);
}

// ── update handling ──────────────────────────────────────────────────────────

function allowed(chatId: number): boolean {
  return ALLOWED.length === 0 ? false : ALLOWED.includes(String(chatId));
}

async function handleUpdate(update: any) {
  const sb = db();

  // Inline button taps (Confirm / Cancel).
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id;
    await answerCallbackQuery(cq.id);
    if (!allowed(chatId)) return;

    const [action, draftId] = String(cq.data).split(":");
    if (action === "confirm") await confirmAndPost(sb, chatId, draftId);
    else if (action === "cancel") {
      await sb.from("bot_pending_txn").update({ status: "cancelled" }).eq("id", draftId);
      await sendMessage(chatId, "Cancelled. Nothing was posted.");
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (!allowed(chatId)) {
    await sendMessage(chatId, "This bot is private. (Your chat id is not allowlisted.)");
    return;
  }

  // Idempotency: ignore Telegram redeliveries of a message we already took.
  const { error: dupErr } = await sb.from("bot_message_log")
    .insert({ telegram_chat_id: chatId, telegram_message_id: msg.message_id });
  if (dupErr) return;

  const text: string = (msg.text ?? msg.caption ?? "").trim();

  // Commands.
  if (text === "/start" || text === "/help") {
    await sendMessage(
      chatId,
      "📒 *Accounts bot*\n\n*Record:* forward a payment SMS/screenshot, or a broker contract-note PDF (password-protected is fine — I unlock and remember the password). I'll propose the journal entry.\n• /done — review & post\n• /cancel — discard the current draft\n\n*Ask:* when nothing is in progress, just type a question (or /ask).\n_e.g. \"balance of Jana Bank in Udit\", \"liabilities of MAAPL\", \"set AU bank minimum to 25000\"._\n\n*Reconcile:* /check then send a bank/credit-card statement — I match every line against your ledger and flag mismatches. /addmissing creates any missing entries.\n\nYour chat id: `" + chatId + "`",
    );
    return;
  }
  if (text === "/cancel") {
    const d = await getOpenDraft(sb, chatId);
    if (d) await sb.from("bot_pending_txn").update({ status: "cancelled" }).eq("id", d.id);
    await sendMessage(chatId, d ? "Draft discarded." : "Nothing to cancel.");
    return;
  }

  const ctx = await loadContext(sb);

  if (text === "/done") {
    const draft = await getOpenDraft(sb, chatId);
    if (!draft || !(draft.entries ?? []).length) {
      await sendMessage(chatId, "No transaction in progress. Send a screenshot first.");
      return;
    }
    const invalid = validateEntries(draft.entries as AgentEntry[]);
    if (invalid || (draft.open_questions ?? []).length) {
      await sendMessage(
        chatId,
        `Not ready yet: ${invalid ?? "please answer the open questions above."}`,
      );
      return;
    }
    await sb.from("bot_pending_txn").update({ status: "awaiting_confirm" }).eq("id", draft.id);
    await sendMessage(
      chatId,
      `*Ready to post:*\n\n${renderDraft(draft.entries as AgentEntry[], ctx, [])}\n\nConfirm?`,
      { buttons: [[{ text: "✅ Confirm & post", data: `confirm:${draft.id}` }, { text: "✕ Cancel", data: `cancel:${draft.id}` }]] },
    );
    return;
  }

  // Media: images vs PDF documents are handled differently. Detect by mime OR
  // filename, since some Telegram clients send documents as octet-stream.
  const photo = msg.photo?.[msg.photo.length - 1]; // largest size
  const docMime = msg.document?.mime_type ?? "";
  const docName = msg.document?.file_name ?? "";
  const imageDoc = msg.document && (/^image\//.test(docMime) || /\.(jpe?g|png|webp)$/i.test(docName))
    ? msg.document : null;
  const pdfDoc = msg.document && (/application\/pdf/.test(docMime) || /\.pdf$/i.test(docName))
    ? msg.document : null;
  const isImage = !!(photo || imageDoc);
  const isMedia = isImage || !!pdfDoc;

  const openDraft = await getOpenDraft(sb, chatId);

  // Waiting on a password for a locked PDF → this text is the password.
  if (!isMedia && text && openDraft?.awaiting === "pdf_password") {
    await handlePasswordReply(sb, chatId, openDraft, text, ctx);
    return;
  }

  // Waiting on which account a statement belongs to → "Book / Account".
  if (!isMedia && text && openDraft?.awaiting === "reconcile_account") {
    const [bookName, acctName] = text.split("/").map((s) => s.trim());
    const acc = ctx.accounts.find((a) =>
      a.name.toLowerCase() === (acctName ?? "").toLowerCase() &&
      ctx.books.find((b) => b.id === a.book_id)?.name.toLowerCase() === (bookName ?? "").toLowerCase()
    ) ?? ctx.accounts.find((a) => a.name.toLowerCase() === (acctName ?? "").toLowerCase());
    if (!acc) {
      await sendMessage(chatId, "Couldn't find that account. Reply as *Book / Account* (exact names).");
      return;
    }
    const st = openDraft.pending?.statement;
    await runReconcileAndReport(
      sb, chatId, openDraft,
      { book_id: acc.book_id, account_id: acc.id, name: acc.name },
      st?.transactions ?? [], st?.source_hint ?? null,
    );
    return;
  }

  // /check → begin reconciling the next statement.
  if (/^\/check\b/i.test(text)) {
    const d = await getOrCreateDraft(sb, chatId);
    await sb.from("bot_pending_txn").update({ mode: "reconcile", awaiting: "statement", pending: {} }).eq("id", d.id);
    await sendMessage(chatId, "🔍 *Reconcile mode.* Send the bank/credit-card statement (image or PDF). /cancel to exit.");
    return;
  }

  // /addmissing → create the entries a reconciliation flagged as missing.
  if (/^\/addmissing\b/i.test(text)) {
    await handleAddMissing(sb, chatId, ctx);
    return;
  }

  // Q&A mode: explicit /ask, OR plain text when no transaction is in progress.
  const askPrefixed = /^\/ask\b/i.test(text);
  if (!isMedia && text && (askPrefixed || !openDraft)) {
    await handleQuery(sb, chatId, text.replace(/^\/ask\s*/i, ""));
    return;
  }

  await sendChatAction(chatId, "typing");
  const draft = await getOrCreateDraft(sb, chatId);

  // Reconcile mode: an incoming statement (image or PDF).
  if (draft.mode === "reconcile" && isMedia) {
    if (pdfDoc) {
      const f = await downloadFile(pdfDoc.file_id);
      const res = await tryReadPdf(f.bytes, await loadPdfPasswords(sb));
      if (!res) {
        await sb.from("bot_pending_txn").update({
          awaiting: "pdf_password",
          pending: { ...(draft.pending ?? {}), lockedPdf: { telegram_file_id: pdfDoc.file_id, file_unique_id: pdfDoc.file_unique_id } },
        }).eq("id", draft.id);
        await sendMessage(chatId, "🔒 Statement is password-protected. Reply with the password (or `password | Label` to remember it).");
        return;
      }
      await runStatement(sb, chatId, draft, ctx, [], res.text);
    } else {
      const src = photo ?? imageDoc;
      const f = await downloadFile(src.file_id);
      await runStatement(sb, chatId, draft, ctx, [{ bytes: f.bytes, mime: f.mime }], null);
    }
    return;
  }

  // Record mode: PDF document (e.g. broker contract note) — may be locked.
  if (pdfDoc) {
    await handlePdfDoc(sb, chatId, draft, ctx, pdfDoc, text);
    return;
  }

  // Record mode: image → add to the draft.
  if (isImage) {
    const src = photo ?? imageDoc;
    const uniqueId = src.file_unique_id;
    const already = (draft.images ?? []).some((i: any) => i.file_unique_id === uniqueId);
    const images = already ? draft.images : [
      ...(draft.images ?? []),
      { telegram_file_id: src.file_id, file_unique_id: uniqueId },
    ];
    const conversation = text
      ? [...(draft.conversation ?? []), { role: "user", text }]
      : draft.conversation;
    await sb.from("bot_pending_txn").update({ images, conversation }).eq("id", draft.id);
    draft.images = images;
    draft.conversation = conversation;
    await runAndReply(sb, chatId, draft, ctx);
    return;
  }

  // Plain text → treat as an answer to the bot's questions.
  if (text) {
    const conversation = [...(draft.conversation ?? []), { role: "user", text }];
    await sb.from("bot_pending_txn").update({ conversation }).eq("id", draft.id);
    draft.conversation = conversation;
    await runAndReply(sb, chatId, draft, ctx);
    return;
  }

  await sendMessage(chatId, "Send a payment screenshot, or /help.");
}

// ── entrypoint ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  // Do the slow work in the background so Telegram gets a fast 200.
  const work = handleUpdate(update).catch(async (e) => {
    console.error("accounts-bot error:", e);
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
    if (!chatId) return;
    const msg = String(e?.message ?? e);
    if (msg.includes("GEMINI_QUOTA")) {
      await sendMessage(
        chatId,
        "⚠️ *Gemini usage limit reached.* I can't read screenshots right now — the AI quota is exhausted (free-tier daily cap or billing limit).\n\nYour draft is saved; try again later, or check quota at aistudio.google.com. Nothing was lost.",
      );
    } else {
      await sendMessage(chatId, "⚠️ Error: " + msg.slice(0, 500), { plain: true });
    }
  });

  // @ts-ignore EdgeRuntime is available in Supabase's runtime
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;

  return new Response("ok");
});
