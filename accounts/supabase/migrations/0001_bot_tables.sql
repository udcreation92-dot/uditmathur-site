-- ============================================================
-- Accounts Telegram Bot — draft-session + payee-memory tables
-- Lives in the SAME project as the Accounts app (swxfxjtnospxnkhznyal)
-- so posted entries appear instantly in the web UI.
-- ============================================================

-- A pending transaction is an OPEN conversation with the bot.
-- One draft can hold MULTIPLE journal entries across different books
-- (e.g. a Udit -> MAAPL transfer = two mirror entries) plus the SHARED
-- screenshot(s) that will be attached to every entry on confirm.
create table if not exists bot_pending_txn (
  id               uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null,

  -- collecting  : still receiving images / answering questions
  -- awaiting_confirm : user sent /done, final draft shown, waiting for ✅
  -- posted / cancelled : terminal
  status           text not null default 'collecting'
                     check (status in ('collecting','awaiting_confirm','posted','cancelled')),

  -- Screenshots for THIS transaction, shared across all entries.
  -- [{ telegram_file_id, file_unique_id, drive_file_id?, file_name?,
  --    mime_type?, web_view_link?, extracted? }]
  images           jsonb not null default '[]'::jsonb,

  -- The proposed postings. A LIST so one image set can yield >1 entry.
  -- [{ book_id, date, narration, reference_no,
  --    lines: [{ account_id | new_account:{book_id,name,type}, debit, credit }] }]
  entries          jsonb not null default '[]'::jsonb,

  -- What the AI still needs from the user (free-form strings shown in chat).
  open_questions   jsonb not null default '[]'::jsonb,

  -- Short rolling transcript so the agent has conversational memory.
  -- [{ role: 'user'|'bot', text }]
  conversation     jsonb not null default '[]'::jsonb,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- At most one OPEN draft per chat (collecting or awaiting_confirm).
-- New images join the open draft; a fresh one starts only after post/cancel.
create unique index if not exists uq_bot_pending_open
  on bot_pending_txn (telegram_chat_id)
  where status in ('collecting','awaiting_confirm');

create index if not exists idx_bot_pending_chat on bot_pending_txn(telegram_chat_id);

-- Idempotency for Telegram's at-least-once delivery: remember handled messages.
create table if not exists bot_message_log (
  telegram_chat_id    bigint not null,
  telegram_message_id bigint not null,
  created_at          timestamptz not null default now(),
  primary key (telegram_chat_id, telegram_message_id)
);

-- Learned payee -> account mapping so the bot stops re-asking
-- "which account is Swiggy?" after the first time. (Phase 2, optional to use.)
create table if not exists bot_payee_map (
  id         uuid primary key default gen_random_uuid(),
  payee      text not null,
  book_id    uuid not null references books(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  hits       int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payee, book_id)
);

create index if not exists idx_bot_payee_lookup on bot_payee_map(lower(payee));

-- ============================================================
-- RLS: these are bot-only tables written with the SERVICE ROLE key,
-- which bypasses RLS. Enable RLS with NO policies so nothing is
-- reachable via the anon key from the browser app.
-- ============================================================
alter table bot_pending_txn enable row level security;
alter table bot_message_log enable row level security;
alter table bot_payee_map   enable row level security;

-- keep updated_at fresh
create or replace function bot_touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_bot_pending_touch on bot_pending_txn;
create trigger trg_bot_pending_touch before update on bot_pending_txn
  for each row execute function bot_touch_updated_at();

drop trigger if exists trg_bot_payee_touch on bot_payee_map;
create trigger trg_bot_payee_touch before update on bot_payee_map
  for each row execute function bot_touch_updated_at();
