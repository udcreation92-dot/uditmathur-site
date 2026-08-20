-- Per-account metadata the ledger can't hold — e.g. the minimum average
-- balance (MAB) a bank requires you to maintain. Used by the bot's Q&A mode
-- to answer "how much must I keep in AU bank?" and compute shortfalls.

create table if not exists bot_account_meta (
  account_id   uuid primary key references accounts(id) on delete cascade,
  min_balance  numeric(15,2),   -- required minimum / MAB, null if none
  note         text,
  updated_at   timestamptz not null default now()
);

alter table bot_account_meta enable row level security;

drop trigger if exists trg_bot_meta_touch on bot_account_meta;
create trigger trg_bot_meta_touch before update on bot_account_meta
  for each row execute function bot_touch_updated_at();
