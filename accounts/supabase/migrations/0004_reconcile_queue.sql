-- Queue of statement transactions still to be added after a reconciliation,
-- so /addmissing can create them in small batches (each with its own confirm),
-- surviving across the individual record-draft confirms.
create table if not exists bot_reconcile_queue (
  telegram_chat_id bigint primary key,
  target     jsonb not null,   -- { book_id, account_id, name }
  missing    jsonb not null,   -- full array of statement transactions
  processed  int not null default 0,
  updated_at timestamptz not null default now()
);

alter table bot_reconcile_queue enable row level security;

drop trigger if exists trg_bot_recq_touch on bot_reconcile_queue;
create trigger trg_bot_recq_touch before update on bot_reconcile_queue
  for each row execute function bot_touch_updated_at();
