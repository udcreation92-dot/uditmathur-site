-- ============================================================
-- Accounts App — Invoicing / Work Orders / Client Master / GST
-- Migration. Paste into Supabase → SQL Editor → Run.
-- Safe to re-run (idempotent where possible).
-- ============================================================

-- Per-book feature toggles
alter table books add column if not exists invoicing_enabled boolean not null default false;
alter table books add column if not exists gst_enabled       boolean not null default false;

-- FIRM PROFILE (1:1 with book — the invoice template + accounting wiring)
create table if not exists firm_profiles (
  book_id             uuid primary key references books(id) on delete cascade,
  firm_name           text,
  tagline             text,
  logo_url            text,               -- data-URL or external link
  address             text,
  gstin               text,
  state_code          text,               -- e.g. "Karnataka, 29"
  email               text,
  mobile              text,
  pan                 text,
  bank_account_name   text,
  bank_account_number text,
  bank_ifsc           text,
  terms               text,
  invoice_prefix      text not null default 'INV',
  next_invoice_no     int  not null default 1,
  next_proforma_no    int  not null default 1,
  -- posting-account wiring (used when a tax invoice is approved)
  debtors_account_id     uuid references accounts(id) on delete set null,
  sales_account_id       uuid references accounts(id) on delete set null,
  output_gst_account_id  uuid references accounts(id) on delete set null,
  input_gst_account_id   uuid references accounts(id) on delete set null,
  updated_at          timestamptz default now()
);

-- CLIENT MASTER (global — reusable across firms)
create table if not exists clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  address    text,
  gstin      text,                        -- null => unregistered / B2C
  state_code text,
  email      text,
  phone      text,
  created_at timestamptz default now()
);

-- CLIENT LEDGER MAP — the party ledger to debit, per client PER FIRM (accounts are
-- per-book, clients are global, so the mapping is keyed by both).
create table if not exists client_ledgers (
  client_id  uuid not null references clients(id)  on delete cascade,
  book_id    uuid not null references books(id)    on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  primary key (client_id, book_id)
);
alter table client_ledgers enable row level security;
do $$ begin
  create policy "allow_auth_client_ledgers" on client_ledgers for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- WORK ORDERS
create table if not exists work_orders (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references books(id)   on delete cascade,
  client_id    uuid not null references clients(id) on delete restrict,
  wo_number    text,
  wo_date      date,
  po_no        text,
  project_site text,
  description  text,
  amount       numeric(15,2) not null default 0 check (amount >= 0),
  status       text not null default 'open' check (status in ('open','completed','cancelled')),
  created_at   timestamptz default now()
);

-- WORK ORDER FILES — Google-Drive-hosted copies of the original WO (PDF/scan)
create table if not exists work_order_files (
  id            uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete cascade,
  drive_file_id text not null,
  file_name     text not null,
  mime_type     text,
  web_view_link text,
  created_at    timestamptz default now()
);
create index if not exists idx_wo_files_wo on work_order_files(work_order_id);
alter table work_order_files enable row level security;
do $$ begin
  create policy "allow_auth_work_order_files" on work_order_files for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- INVOICES (proforma -> tax lifecycle)
create table if not exists invoices (
  id                 uuid primary key default gen_random_uuid(),
  book_id            uuid not null references books(id)   on delete cascade,
  client_id          uuid not null references clients(id) on delete restrict,
  work_order_id      uuid references work_orders(id) on delete set null,
  proforma_no        text,
  invoice_no         text,                -- tax-invoice no, assigned on approval
  invoice_date       date not null,
  due_date           date,
  approved_at        timestamptz,
  place_of_supply    text,                -- state, e.g. "Karnataka, 29"
  is_interstate      boolean not null default false,
  status             text not null default 'proforma'
                     check (status in ('proforma','tax','paid','void')),
  taxable_total      numeric(15,2) not null default 0,
  cgst_total         numeric(15,2) not null default 0,
  sgst_total         numeric(15,2) not null default 0,
  igst_total         numeric(15,2) not null default 0,
  grand_total        numeric(15,2) not null default 0,
  amount_in_words    text,
  notes              text,
  firm_snapshot      jsonb,               -- frozen at approval
  client_snapshot    jsonb,               -- frozen at approval
  journal_entry_id   uuid references journal_entries(id) on delete set null,
  created_at         timestamptz default now(),
  unique (book_id, invoice_no)
);

-- Party ledger to debit — chosen per-invoice (the client's own ledger account)
alter table invoices add column if not exists debtor_account_id uuid references accounts(id) on delete set null;

-- FY-aware numbering: sequence derived from existing rows (per book, per FY), gap-free on delete
alter table invoices add column if not exists fin_year text;
alter table invoices add column if not exists seq_no  int;

-- WORK ORDER STAGES (payment terms; billed one-by-one into invoices)
create table if not exists work_order_stages (
  id            uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete cascade,
  seq           int not null default 0,
  label         text,
  basis         text not null default 'amount' check (basis in ('amount','percent')),
  value         numeric(15,2) not null default 0,
  invoice_id    uuid references invoices(id) on delete set null,
  created_at    timestamptz default now()
);

-- Stages billed BEFORE this system existed (prior-year) — marked done without an
-- invoice/journal entry, so only the remaining stages get billed going forward.
alter table work_order_stages add column if not exists billed_external boolean not null default false;
alter table work_order_stages add column if not exists billed_ref  text;
alter table work_order_stages add column if not exists billed_date date;

-- INVOICE LINE ITEMS
create table if not exists invoice_items (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references invoices(id) on delete cascade,
  seq           int not null default 0,
  description   text,
  hsn_sac       text,
  taxable_value numeric(15,2) not null default 0,
  cgst_rate     numeric(6,2)  not null default 0,
  cgst_amt      numeric(15,2) not null default 0,
  sgst_rate     numeric(6,2)  not null default 0,
  sgst_amt      numeric(15,2) not null default 0,
  igst_rate     numeric(6,2)  not null default 0,
  igst_amt      numeric(15,2) not null default 0,
  line_total    numeric(15,2) not null default 0
);

-- INDEXES
create index if not exists idx_wo_book        on work_orders(book_id);
create index if not exists idx_wo_client      on work_orders(client_id);
create index if not exists idx_wo_stages_wo   on work_order_stages(work_order_id);
create index if not exists idx_inv_book       on invoices(book_id);
create index if not exists idx_inv_client     on invoices(client_id);
create index if not exists idx_inv_wo         on invoices(work_order_id);
create index if not exists idx_inv_items_inv  on invoice_items(invoice_id);

-- ROW LEVEL SECURITY (single-user app: any authenticated user, matching existing pattern)
alter table firm_profiles     enable row level security;
alter table clients           enable row level security;
alter table work_orders       enable row level security;
alter table work_order_stages enable row level security;
alter table invoices          enable row level security;
alter table invoice_items     enable row level security;

do $$ begin
  create policy "allow_auth_firm_profiles"     on firm_profiles     for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow_auth_clients"           on clients           for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow_auth_work_orders"       on work_orders       for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow_auth_work_order_stages" on work_order_stages for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow_auth_invoices"          on invoices          for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow_auth_invoice_items"     on invoice_items     for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
