// Voucher storage in Supabase Storage (used instead of Google Drive, because a
// service account cannot own files on a personal Gmail). Private bucket + a
// long-lived signed URL stored as the attachment link, so bank screenshots
// aren't publicly guessable yet the web app can still open them.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "vouchers";
const SIGNED_URL_TTL = 60 * 60 * 24 * 365 * 10; // ~10 years

// Same shape the poster/Drive path used, so downstream code is unchanged.
export interface StoredFile {
  id: string; // storage object path
  name: string;
  mimeType: string;
  webViewLink: string;
}

let bucketReady = false;

async function ensureBucket(sb: SupabaseClient): Promise<void> {
  if (bucketReady) return;
  const { error } = await sb.storage.createBucket(BUCKET, { public: false });
  // "already exists" is fine; anything else is a real problem.
  if (error && !/exist/i.test(error.message)) throw new Error(`create bucket: ${error.message}`);
  bucketReady = true;
}

export async function uploadVoucher(
  sb: SupabaseClient,
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
): Promise<StoredFile> {
  await ensureBucket(sb);

  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}_${fileName}`;
  const { error: upErr } = await sb.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mimeType, upsert: false });
  if (upErr) throw new Error(`storage upload: ${upErr.message}`);

  const { data, error: signErr } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (signErr || !data) throw new Error(`sign url: ${signErr?.message ?? "no url"}`);

  return { id: path, name: fileName, mimeType, webViewLink: data.signedUrl };
}
