# Accounts Telegram Bot — setup

Forward a payment SMS/screenshot to a Telegram bot → Gemini reads it and proposes
the journal entry → you confirm → it posts into the same Supabase the web app
reads (project `swxfxjtnospxnkhznyal`), voucher image attached.

Nothing posts without an explicit **✅ Confirm** tap.

---

## 1. Database

Apply the migration (creates `bot_pending_txn`, `bot_message_log`, `bot_payee_map`):

```bash
cd accounts
supabase link --project-ref swxfxjtnospxnkhznyal
supabase db push
```

(Or paste `supabase/migrations/0001_bot_tables.sql` into the SQL editor.)

## 2. Telegram bot

1. Talk to **@BotFather** → `/newbot` → copy the **bot token**.
2. Message your new bot once (say `/start`) so a chat exists.
3. Get your **chat id**: after deploy, the bot replies to `/start` with it, or
   visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id`.

## 3. Google service account (Drive uploads)

1. Google Cloud Console → create/pick a project → **Enable the Google Drive API**.
2. IAM → Service Accounts → **Create service account** → create a **JSON key**, download it.
3. In your Google Drive, open the existing **"Accounts Vouchers"** folder →
   **Share** it (Editor) with the service account's email
   (`...@...iam.gserviceaccount.com`).
4. Get the folder id from its URL: `drive.google.com/drive/folders/<FOLDER_ID>`.

The service account uploads *into your folder*, so files count against **your**
Drive quota (free tier) and sit next to manually-added vouchers. It also grants
your email read access to each file so the stored link opens for you.

## 4. Gemini key

Google AI Studio → **Get API key**. Use a paid/project key if you don't want your
financial screenshots used for training.

## 5. Function secrets

```bash
supabase secrets set \
  TELEGRAM_BOT_TOKEN="123456:ABC..." \
  TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 16)" \
  ALLOWED_CHAT_IDS="<your chat id>" \
  GEMINI_API_KEY="AIza..." \
  GEMINI_MODEL="gemini-2.5-flash" \
  DRIVE_FOLDER_ID="<Accounts Vouchers folder id>" \
  DRIVE_SHARE_WITH="udcreation92@gmail.com" \
  GOOGLE_SERVICE_ACCOUNT="$(cat service-account.json)"
```

Notes:
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by Supabase.
- `ALLOWED_CHAT_IDS` is a comma-separated allowlist — only these chats can post entries.
- Keep `TELEGRAM_WEBHOOK_SECRET` handy; it's reused in step 7.

## 6. Deploy

```bash
supabase functions deploy accounts-bot
```

## 7. Point Telegram at the function

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://swxfxjtnospxnkhznyal.supabase.co/functions/v1/accounts-bot" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

## 8. Try it

1. `/start` → bot confirms it's alive and echoes your chat id.
2. Forward a payment screenshot → bot proposes the entry (asks if unsure which
   book / account, or offers to create a new account).
3. Send more screenshots if the transaction spans several images.
4. Answer any questions in chat.
5. `/done` → review → **✅ Confirm** → posted. Check the Ledger in the web app.

### Transfers between books
For e.g. "Dr Jana Bank ₹20,000 → MAAPL", make sure the **inter-ledger link**
(Udit ↔ MAAPL mirror accounts) exists on the Chart of Accounts → Reconciliation
Links page. The bot uses it to post both sides (one entry per book, same voucher
attached to each).

---

## Cost
- Service account, Drive API, Supabase function: free.
- Gemini 2.5 Flash at ~5 screenshots/day: roughly ₹30–110/month (often free-tier).
