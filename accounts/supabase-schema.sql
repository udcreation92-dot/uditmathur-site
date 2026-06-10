-- ============================================================
-- Accounts App — Database Schema
-- Paste this entire file into Supabase → SQL Editor → Run
-- ============================================================

-- BOOKS
create table if not exists books (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_at  timestamptz default now()
);

-- ACCOUNTS (chart of accounts per book)
create table if not exists accounts (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references books(id) on delete cascade,
  name       text not null,
  code       text,
  type       text not null check (type in ('asset','liability','equity','income','expense')),
  created_at timestamptz default now(),
  unique(book_id, code)
);

-- INTER-LEDGER RECONCILIATION LINKS
create table if not exists inter_ledger_links (
  id           uuid primary key default gen_random_uuid(),
  account_a_id uuid not null references accounts(id) on delete cascade,
  account_b_id uuid not null references accounts(id) on delete cascade,
  created_at   timestamptz default now(),
  unique(account_a_id, account_b_id)
);

-- JOURNAL ENTRIES (header)
create table if not exists journal_entries (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references books(id) on delete cascade,
  date         date not null,
  narration    text,
  reference_no text,
  created_at   timestamptz default now()
);

-- JOURNAL LINES (debit / credit rows)
create table if not exists journal_lines (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references journal_entries(id) on delete cascade,
  account_id uuid not null references accounts(id),
  debit      numeric(15,2) not null default 0 check (debit  >= 0),
  credit     numeric(15,2) not null default 0 check (credit >= 0),
  created_at timestamptz default now(),
  check (debit > 0 or credit > 0)
);

-- ATTACHMENTS (Google Drive file references)
create table if not exists attachments (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references journal_entries(id) on delete cascade,
  drive_file_id text not null,
  file_name     text not null,
  mime_type     text,
  web_view_link text,
  created_at    timestamptz default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists idx_accounts_book     on accounts(book_id);
create index if not exists idx_entries_book_date on journal_entries(book_id, date);
create index if not exists idx_lines_entry       on journal_lines(entry_id);
create index if not exists idx_lines_account     on journal_lines(account_id);
create index if not exists idx_attach_entry      on attachments(entry_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- Single-user app: any authenticated user can read/write all rows.
-- ============================================================
alter table books              enable row level security;
alter table accounts           enable row level security;
alter table inter_ledger_links enable row level security;
alter table journal_entries    enable row level security;
alter table journal_lines      enable row level security;
alter table attachments        enable row level security;

create policy "allow_auth_books"   on books              for all to authenticated using (true) with check (true);
create policy "allow_auth_accts"   on accounts           for all to authenticated using (true) with check (true);
create policy "allow_auth_links"   on inter_ledger_links for all to authenticated using (true) with check (true);
create policy "allow_auth_entries" on journal_entries    for all to authenticated using (true) with check (true);
create policy "allow_auth_lines"   on journal_lines      for all to authenticated using (true) with check (true);
create policy "allow_auth_attach"  on attachments        for all to authenticated using (true) with check (true);

-- ============================================================
-- FUND OPTIMIZER TABLES (migration — safe to run on existing DB)
-- ============================================================

-- Per-account settings: role, interest rate, minimum balance requirement
create table if not exists account_settings (
  account_id       uuid primary key references accounts(id) on delete cascade,
  account_role     text not null default 'other'
                   check (account_role in ('savings','current','credit_card','trading','investment','other')),
  interest_rate_pa numeric(6,3)  not null default 0 check (interest_rate_pa >= 0),
  min_balance      numeric(15,2) not null default 0 check (min_balance >= 0),
  updated_at       timestamptz default now()
);

-- Scheduled outflows: one-time and recurring commitments
create table if not exists commitments (
  id              uuid primary key default gen_random_uuid(),
  book_id         uuid not null references books(id) on delete cascade,
  account_id      uuid not null references accounts(id) on delete cascade,
  description     text not null,
  amount          numeric(15,2) not null check (amount > 0),
  commitment_type text not null check (commitment_type in ('one_time','recurring')),
  due_date        date,
  -- recurrence JSONB examples:
  --   monthly specific day:  {"freq":"monthly","day":15}
  --   monthly nth weekday:   {"freq":"monthly","nth":1,"weekday":0}  (0=Sun)
  --   weekly:                {"freq":"weekly","weekday":5}           (5=Fri)
  recurrence      jsonb,
  is_active       boolean not null default true,
  created_at      timestamptz default now(),
  constraint one_time_needs_date check (
    (commitment_type = 'one_time' and due_date is not null) or
    (commitment_type = 'recurring' and recurrence is not null)
  )
);

create index if not exists idx_acct_settings      on account_settings(account_id);
create index if not exists idx_commitments_book   on commitments(book_id);
create index if not exists idx_commitments_account on commitments(account_id);

alter table account_settings enable row level security;
alter table commitments       enable row level security;

create policy "allow_auth_acct_settings" on account_settings for all to authenticated using (true) with check (true);
create policy "allow_auth_commitments"   on commitments       for all to authenticated using (true) with check (true);
