// Thin Telegram Bot API helpers (text + photos + inline confirm buttons).

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { buttons?: { text: string; data: string }[][]; plain?: boolean } = {},
): Promise<void> {
  // Telegram hard-limits messages to 4096 chars; a longer one is rejected and
  // silently dropped. Truncate to stay safely under.
  const safe = text.length > 4000 ? text.slice(0, 3950) + "\n…(truncated)" : text;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: safe,
    disable_web_page_preview: true,
  };
  // Markdown by default, but skip it for raw/error text that may contain
  // characters Telegram's parser rejects (which would drop the message).
  if (!opts.plain) body.parse_mode = "Markdown";
  if (opts.buttons) {
    body.reply_markup = {
      inline_keyboard: opts.buttons.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.data }))
      ),
    };
  }
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function sendChatAction(chatId: number, action = "typing"): Promise<void> {
  await fetch(`${API}/sendChatAction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

// Acknowledge a tapped inline button so Telegram stops the loading spinner.
export async function answerCallbackQuery(id: string, text?: string): Promise<void> {
  await fetch(`${API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text: text ?? "" }),
  });
}

export interface TgFile {
  bytes: Uint8Array;
  mime: string;
  fileName: string;
  filePath: string;
}

// Download any Telegram file (photo/document) by file_id.
export async function downloadFile(fileId: string): Promise<TgFile> {
  const meta = await fetch(`${API}/getFile?file_id=${fileId}`).then((r) => r.json());
  if (!meta?.ok) throw new Error(`telegram getFile failed: ${JSON.stringify(meta)}`);
  const path: string | undefined = meta?.result?.file_path;
  if (!path) throw new Error("telegram getFile: no file_path");
  const res = await fetch(`${FILE_API}/${path}`);
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  // Guard: a stale file_id can yield an HTML error page, not an image.
  // JPEG starts FFD8, PNG 8950, PDF 2550, WEBP "RIFF".
  const head = new Uint8Array(buf.slice(0, 4));
  const hex = Array.from(head).map((b) => b.toString(16).padStart(2, "0")).join("");
  const looksBinary = /^(ffd8|8950|2550|5249)/.test(hex);
  if (!looksBinary) throw new Error(`downloaded file is not an image/pdf (header ${hex})`);
  const ext = path.split(".").pop()?.toLowerCase() ?? "jpg";
  const mime = ext === "png" ? "image/png"
    : ext === "pdf" ? "application/pdf"
    : ext === "webp" ? "image/webp"
    : "image/jpeg";
  return {
    bytes: new Uint8Array(buf),
    mime,
    fileName: path.split("/").pop() ?? `file.${ext}`,
    filePath: path,
  };
}
