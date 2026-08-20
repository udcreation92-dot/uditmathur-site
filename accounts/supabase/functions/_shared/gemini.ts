// The brain: Gemini 2.5 Flash, multimodal. Reads the voucher image(s) AND
// reasons about the double-entry posting in a single call. Returns strict JSON.

const KEY = Deno.env.get("GEMINI_API_KEY")!;
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

export interface AgentLine {
  // Exactly one of account_id / new_account must be present.
  account_id?: string;
  new_account?: { book_id: string; name: string; type: string };
  debit: number;
  credit: number;
}
export interface AgentEntry {
  book_id: string;
  date: string; // YYYY-MM-DD
  narration: string;
  reference_no: string | null;
  lines: AgentLine[];
  // The outside party for this entry (e.g. "Swiggy", "Jana Bank"), and which
  // line's account is the category/counterparty to remember for that payee.
  payee?: string | null;
  category_line_index?: number | null;
}
export interface AgentResult {
  entries: AgentEntry[];
  questions: string[];
  summary: string; // human-readable recap shown in Telegram
  ready: boolean; // true only when no questions remain and entries balance
}

export interface AgentImage { bytes: Uint8Array; mime: string }
export interface AgentTurn { role: "user" | "bot"; text: string }

const SYSTEM = `You are a bookkeeping assistant for a double-entry accounting app used by a single owner in India (amounts in INR).

You receive: (1) the owner's chart of accounts (books, accounts, and inter-ledger mirror links), (2) one or more screenshots of a payment/transaction (bank SMS, UPI confirmation, receipt), and (3) the running conversation.

Your job: propose the journal entry/entries to record the transaction, then STOP for the owner to confirm. Never assume you may post — a separate step does that.

CRITICAL RULES:
- Output double-entry postings where EACH entry balances: sum(debit) == sum(credit).
- Amounts are numbers in rupees (no currency symbol, no commas).
- Use ONLY account ids that appear in the context. To reference an account, put its id in "account_id".
- If a needed account does NOT exist, propose it via "new_account": { book_id, name, type } where type is one of asset|liability|equity|income|expense. Add a question asking the owner to approve creating it. Do NOT invent an account_id.
- A single payment MAY require entries in MORE THAN ONE book. If money moves between two of the owner's own books (a transfer), output TWO balanced entries — one per book — using the mirror accounts from the inter-ledger links. Example: "Dr Jana Bank ... transfer to MAAPL" => one entry in the source book (Cr the bank, Dr the mirror/receivable) and one entry in MAAPL (Dr its cash/bank, Cr the mirror/payable).
- If you cannot tell whether it is an internal transfer or a payment to an outside party, ASK rather than guess.
- Prefer dates from the screenshot; if absent, use today's date (given below).
- Multiple screenshots may describe ONE transaction (e.g. SMS + app confirmation) — merge them, do not double count.
- Keep narration short and specific (payee + purpose).
- BROKER CONTRACT NOTES (e.g. Shoonya/Finvasia, Zerodha): book ONLY the single NET amount payable/receivable (the "net amount" / "net obligation" on the note) as ONE entry — Dr/Cr the broker or bank account against a Trading/Investment account. Do NOT itemize brokerage, STT, GST, stamp duty or exchange charges. Use the net-payable = money out (buy) / net-receivable = money in (sell). Put the contract note number in reference_no. If the net amount isn't clear from the text, ask for it.
- Set "payee" to the outside party (e.g. "Swiggy", "Jana Bank") and "category_line_index" to the 0-based index of the line whose account is the category/counterparty for that payee (the expense/income/party account, NOT the bank/cash side). This lets the app remember the mapping. Omit for pure book-to-book transfers.
- KNOWN PAYEE MAPPINGS in the context were previously confirmed by the owner — reuse the same account for a matching payee instead of asking, unless the screenshot clearly indicates a different category.

Respond with STRICT JSON ONLY, matching:
{
  "entries": [
    { "book_id": "<id>", "date": "YYYY-MM-DD", "narration": "<text>",
      "reference_no": "<txn/ref no or null>",
      "payee": "<outside party or null>", "category_line_index": <int or null>,
      "lines": [ { "account_id": "<id>" | "new_account": {"book_id":"<id>","name":"<text>","type":"<type>"}, "debit": <num>, "credit": <num> } ] }
  ],
  "questions": [ "<clarifying question>", ... ],
  "summary": "<one short human-readable recap of what will be posted>",
  "ready": <true only if questions is empty AND every entry balances>
}`;

export async function runAgent(
  contextText: string,
  images: AgentImage[],
  conversation: AgentTurn[],
  todayISO: string,
  documentTexts: string[] = [],
): Promise<AgentResult> {
  const parts: unknown[] = [];

  parts.push({
    text:
      `TODAY: ${todayISO}\n\nCHART OF ACCOUNTS CONTEXT:\n${contextText}\n\n` +
      (conversation.length
        ? `CONVERSATION SO FAR:\n${conversation.map((t) => `${t.role}: ${t.text}`).join("\n")}\n\n`
        : "") +
      (documentTexts.length
        ? `ATTACHED DOCUMENT TEXT (extracted from PDF, e.g. a broker contract note):\n${
          documentTexts.map((t, i) => `--- document ${i + 1} ---\n${t}`).join("\n\n")
        }\n\n`
        : "") +
      `Analyse the attached screenshot(s) and/or document text and produce the JSON described in the system instructions.`,
  });

  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mime, data: toBase64(img.bytes) } });
  }

  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    // 429 = rate limit / daily quota exhausted (free-tier cap or billing limit).
    if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(bodyText)) {
      throw new Error(`GEMINI_QUOTA: ${res.status} ${bodyText}`);
    }
    throw new Error(`Gemini error: ${res.status} ${bodyText}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");

  const parsed = JSON.parse(text) as AgentResult;
  // Defensive defaults.
  parsed.entries ??= [];
  parsed.questions ??= [];
  parsed.summary ??= "";
  parsed.ready = !!parsed.ready && parsed.questions.length === 0;
  return parsed;
}

// ── Q&A mode ─────────────────────────────────────────────────────────────────

export interface QueryResult {
  answer: string;
  set_min?: { account_id: string; amount: number } | null;
}

const QUERY_SYSTEM =
  `You answer questions about the owner's accounts using ONLY the FINANCIAL SNAPSHOT provided (INR, India). The snapshot already contains exact, pre-computed figures — balances, this-month averages, type subtotals, MAB requirements and shortfalls. Read the relevant number off the snapshot; do NOT invent or recompute figures beyond trivial addition the snapshot doesn't already give.

- Be concise and specific. Quote the figure and the account/book it came from.
- If the answer isn't derivable from the snapshot, say so plainly (e.g. forecasts of future funds need data not in the ledger).
- If the owner is asking to SET/record a minimum balance (MAB) for an account, resolve the account from the snapshot and return it in "set_min" with the amount; keep "answer" as a short confirmation.

Respond with STRICT JSON ONLY:
{ "answer": "<text to send back>", "set_min": {"account_id":"<id>","amount":<number>} | null }`;

export async function runQuery(snapshot: string, question: string): Promise<QueryResult> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: QUERY_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: `${snapshot}\n\nQUESTION: ${question}` }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(bodyText)) {
      throw new Error(`GEMINI_QUOTA: ${res.status} ${bodyText}`);
    }
    throw new Error(`Gemini error: ${res.status} ${bodyText}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");
  const parsed = JSON.parse(text) as QueryResult;
  parsed.answer ??= "";
  return parsed;
}

// ── Statement extraction (reconciliation) ────────────────────────────────────

export interface StatementTxn {
  date: string; // YYYY-MM-DD
  amount: number; // absolute rupee value
  direction: "debit" | "credit"; // money out of / into the account as shown on the statement
  description: string;
}
export interface StatementExtract {
  source_hint: string | null; // e.g. "HDFC credit card", "AU Bank a/c 1234"
  transactions: StatementTxn[];
}

const STATEMENT_SYSTEM =
  `You extract EVERY transaction line from a bank or credit-card statement (image and/or extracted PDF text). Amounts in INR.

- "amount" = absolute rupee value (no sign, no commas).
- "direction" = "debit" (money leaving the account / a card spend) or "credit" (money into the account / a payment or refund).
- "date" = the transaction date as YYYY-MM-DD.
- "source_hint" = the account this statement is for, from the header (bank name + last 4 digits, or "<Bank> credit card"). null if unclear.
- Ignore opening/closing balance rows, subtotals, and summary lines — only real transactions.

Respond with STRICT JSON ONLY:
{ "source_hint": "<text|null>", "transactions": [ {"date":"YYYY-MM-DD","amount":<num>,"direction":"debit|credit","description":"<text>"} ] }`;

export async function extractStatement(
  images: AgentImage[],
  documentText: string | null,
): Promise<StatementExtract> {
  // Keep a generous input cap (Gemini handles large context; this only guards
  // against a pathologically huge file). Ledgers with many rows fit easily.
  const docText = documentText && documentText.length > 120000
    ? documentText.slice(0, 120000)
    : documentText;

  const parts: unknown[] = [{
    text: docText
      ? `Extracted statement text:\n${docText}\n\nExtract all transactions as JSON.`
      : `Extract all transactions from the attached statement image(s) as JSON.`,
  }];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mime, data: toBase64(img.bytes) } });
  }

  // Abort if Gemini takes too long, so we fail with an error instead of letting
  // the edge isolate get killed mid-request (which would swallow the failure).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);
  let res: Response;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: STATEMENT_SYSTEM }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 32768 },
      }),
    });
  } catch (e) {
    throw new Error(`Gemini statement request failed/timed out: ${String(e).slice(0, 150)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await res.text();
    if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(bodyText)) {
      throw new Error(`GEMINI_QUOTA: ${res.status} ${bodyText}`);
    }
    throw new Error(`Gemini error: ${res.status} ${bodyText}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content (statement)");
  let parsed: StatementExtract;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")) as StatementExtract;
  } catch {
    throw new Error("Couldn't parse the statement (response may have been truncated).");
  }
  parsed.transactions ??= [];
  parsed.source_hint ??= null;
  return parsed;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
