// Upload voucher images to Google Drive using the service account, into the
// SAME "Accounts Vouchers" folder the web app uses. The folder is shared
// (Editor) from the user's Drive to the service account, so files count against
// the user's quota and live alongside manually-uploaded vouchers.
//
// Set DRIVE_FOLDER_ID to that folder's id (from its Drive URL).
// Set DRIVE_SHARE_WITH to the user's Google email so uploaded files are viewable.

import { getGoogleAccessToken } from "./googleAuth.ts";

const FOLDER_ID = Deno.env.get("DRIVE_FOLDER_ID")!;
const SHARE_WITH = Deno.env.get("DRIVE_SHARE_WITH"); // optional

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
}

export async function uploadToDrive(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
): Promise<DriveFile> {
  const token = await getGoogleAccessToken();

  const meta = JSON.stringify({ name: fileName, parents: [FOLDER_ID] });
  const boundary = "acctbot" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();

  // multipart/related: JSON metadata part + binary file part.
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  const file = (await res.json()) as DriveFile;

  // Grant the user read access so the stored web_view_link opens for them.
  if (SHARE_WITH) {
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "user", emailAddress: SHARE_WITH }),
      },
    ).catch(() => {}); // non-fatal: folder-share usually already covers visibility
  }

  return file;
}
