// Loads the chart-of-accounts context the agent needs to post correctly:
// books, accounts (per book), and inter-ledger links (the Udit<->MAAPL mirrors).

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface Book { id: string; name: string }
export interface Account { id: string; book_id: string; name: string; type: string; code: string | null }
export interface LedgerLink {
  a: { book: string; name: string; id: string };
  b: { book: string; name: string; id: string };
}

export interface PayeeHint { payee: string; book: string; account: string; account_id: string }

export interface AccountsContext {
  books: Book[];
  accounts: Account[];
  links: LedgerLink[];
  payees: PayeeHint[];
}

export async function loadContext(sb: SupabaseClient): Promise<AccountsContext> {
  const [{ data: books }, { data: accounts }, { data: links }, { data: payees }] = await Promise.all([
    sb.from("books").select("id, name").order("name"),
    sb.from("accounts").select("id, book_id, name, type, code").order("name"),
    sb.from("inter_ledger_links").select(`
      account_a:account_a_id(id, name, books(name)),
      account_b:account_b_id(id, name, books(name))`),
    sb.from("bot_payee_map").select(`
      payee, account_id,
      books(name), accounts(name)`).order("hits", { ascending: false }).limit(200),
  ]);

  const mapped: LedgerLink[] = (links ?? []).map((l: any) => ({
    a: { id: l.account_a.id, name: l.account_a.name, book: l.account_a.books.name },
    b: { id: l.account_b.id, name: l.account_b.name, book: l.account_b.books.name },
  }));

  const payeeHints: PayeeHint[] = (payees ?? []).map((p: any) => ({
    payee: p.payee,
    book: p.books?.name ?? "?",
    account: p.accounts?.name ?? "?",
    account_id: p.account_id,
  }));

  return { books: books ?? [], accounts: accounts ?? [], links: mapped, payees: payeeHints };
}

// Compact, model-friendly rendering of the context for the prompt.
export function renderContext(ctx: AccountsContext): string {
  const byBook = ctx.books.map((b) => {
    const accts = ctx.accounts
      .filter((a) => a.book_id === b.id)
      .map((a) => `    - "${a.name}" [${a.type}] id=${a.id}`)
      .join("\n");
    return `  BOOK "${b.name}" id=${b.id}\n${accts || "    (no accounts yet)"}`;
  }).join("\n");

  const links = ctx.links.length
    ? ctx.links.map((l) =>
      `  - ${l.a.book}."${l.a.name}" (id=${l.a.id})  <->  ${l.b.book}."${l.b.name}" (id=${l.b.id})`
    ).join("\n")
    : "  (none)";

  const payees = ctx.payees.length
    ? ctx.payees.map((p) =>
      `  - "${p.payee}" -> ${p.book}."${p.account}" (id=${p.account_id})`
    ).join("\n")
    : "  (none yet)";

  return `BOOKS & ACCOUNTS:\n${byBook}\n\n` +
    `INTER-LEDGER MIRROR LINKS (use these for transfers between books):\n${links}\n\n` +
    `KNOWN PAYEE MAPPINGS (previously confirmed by the owner — reuse the same account for these payees instead of asking again, unless context clearly differs):\n${payees}`;
}
