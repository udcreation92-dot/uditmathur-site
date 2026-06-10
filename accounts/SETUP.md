# Accounts App — Setup Guide

## 1. Supabase (Database + Auth)

1. Go to https://supabase.com and create a new project (free tier is fine).
2. In **SQL Editor**, paste and run the entire contents of `supabase-schema.sql`.
3. Go to **Authentication → Users → Add user** and create:
   - Email: `udcreation92@gmail.com`
   - Set a strong password
4. Note your **Project URL** and **anon/public key** from Settings → API.

## 2. Google Drive API

1. Go to https://console.cloud.google.com and create a new project (e.g. "Accounts App").
2. Enable the **Google Drive API** (APIs & Services → Library → search "Drive API").
3. Create **OAuth 2.0 credentials**:
   - Application type: **Web application**
   - Authorised JavaScript origins: `https://uditmathur.uk`
   - Authorised redirect URIs: (leave blank for token-based flow)
4. Note the **Client ID**.
5. Create an **API key** (APIs & Services → Credentials → Create credentials → API key).
   - Restrict it to your domain and to the Drive API.

## 3. Environment variables

Copy `.env.example` to `.env`:

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=AIza...
```

## 4. Build & deploy to Cloudflare Pages

```bash
npm install
npm run build
```

This creates a `dist/` folder.

In **Cloudflare Pages**:
1. Create a new Pages project, connect your GitHub repo (or upload the `dist/` folder directly).
2. Build command: `npm run build`
3. Build output directory: `dist`
4. Add the environment variables from `.env` under Settings → Environment variables.
5. In your Cloudflare DNS, point `uditmathur.uk` to Cloudflare Pages (it may already be if the domain is on Cloudflare).
6. The app will be served at `uditmathur.uk/accounts/`.

## 5. CSV/Excel import format

See the template download inside the Bulk Import page. Column names are flexible:

| Column | Accepted names |
|--------|---------------|
| date | date, dt, transaction date |
| narration | narration, description, particulars |
| reference | reference, ref, voucher, cheque |
| account | account_name, account, acc name |
| debit | debit, dr, debit amount |
| credit | credit, cr, credit amount |

One row = one journal line. Rows sharing the same date + narration + reference form one journal entry.

## 6. Reconciliation setup

1. Create books (e.g. "Udit Mathur", "Narendra Mathur").
2. In each book's Chart of Accounts, create a mirror account (e.g. "Narendra Mathur" in Udit's book and "Udit Mathur" in Narendra's book).
3. Go to Chart of Accounts → Reconciliation Links → link the two accounts.
4. The Reconciliation page will then show balance comparison and flag any mismatch instantly.
