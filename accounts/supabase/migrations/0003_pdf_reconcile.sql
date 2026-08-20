-- Locked-PDF handling + statement reconciliation support.

-- Saved PDF-open passwords, keyed by a human label ("kind" of document).
-- The bot tries each saved password on a locked PDF; the one that opens it
-- identifies the kind. Passwords are often a PAN — private, service-role only.
create table if not exists bot_pdf_passwords (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  password   text not null,
  hits       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seed the known Shoonya contract-note password.
insert into bot_pdf_passwords (label, password)
values ('Shoonya contract note', 'BCUPM9845G')
on conflict (label) do nothing;

-- Remembers which book+account a given kind of statement reconciles against,
-- so "HDFC credit card" is only asked once.
create table if not exists bot_stmt_account_map (
  id         uuid primary key default gen_random_uuid(),
  source     text not null unique,   -- e.g. "HDFC credit card"
  book_id    uuid not null references books(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  hits       int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Extra draft state: record vs reconcile mode, what we're waiting on, and a
-- scratch payload (pending PDF file, extracted statement lines, target account).
alter table bot_pending_txn add column if not exists mode     text not null default 'record';
alter table bot_pending_txn add column if not exists awaiting text;         -- e.g. 'pdf_password'
alter table bot_pending_txn add column if not exists pending  jsonb not null default '{}'::jsonb;

alter table bot_pdf_passwords    enable row level security;
alter table bot_stmt_account_map enable row level security;

drop trigger if exists trg_bot_pdfpw_touch on bot_pdf_passwords;
create trigger trg_bot_pdfpw_touch before update on bot_pdf_passwords
  for each row execute function bot_touch_updated_at();

drop trigger if exists trg_bot_stmtmap_touch on bot_stmt_account_map;
create trigger trg_bot_stmtmap_touch before update on bot_stmt_account_map
  for each row execute function bot_touch_updated_at();
