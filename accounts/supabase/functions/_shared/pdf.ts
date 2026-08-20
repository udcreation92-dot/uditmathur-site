// Reading and decrypting password-protected PDFs inside the edge runtime.
// Reading uses unpdf (pdf.js) — reliable. Producing a decrypted copy uses
// qpdf-wasm — best-effort; on any failure we fall back to the original bytes.

// deno-lint-ignore-file no-explicit-any
// `?no-dts` skips unpdf's bundled type defs (which reference @types/node and
// break Deno's checker); runtime is unaffected.
// @ts-ignore - untyped remote import
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1?no-dts";

export interface PdfPassword { label: string; password: string }

// pdf.js throws a PasswordException: code 1 = needs password, 2 = wrong password.
export function isPasswordError(e: unknown): boolean {
  return /password/i.test(String((e as any)?.message ?? e));
}

// pdf.js DETACHES the ArrayBuffer it's given (transfers it to its worker), so
// every call must get its own fresh copy or subsequent calls throw DataCloneError.
const fresh = (bytes: Uint8Array) => new Uint8Array(bytes.slice().buffer);

export async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  try {
    await getDocumentProxy(fresh(bytes));
    return false;
  } catch (e) {
    if (isPasswordError(e)) return true;
    throw e;
  }
}

// Extract text; pass password for encrypted PDFs. Throws on wrong password.
export async function extractPdfText(bytes: Uint8Array, password?: string): Promise<string> {
  const pdf = await getDocumentProxy(fresh(bytes), password ? { password } : undefined);
  const { text } = await extractText(pdf, { mergePages: true });
  return typeof text === "string" ? text : (text as string[]).join("\n");
}

export interface UnlockResult {
  text: string;
  password: string | null; // null when the PDF wasn't encrypted
  label: string | null; // which saved password worked
}

// Try to read a PDF: if encrypted, try each saved password until one opens it.
// Returns null if it's encrypted and no saved password works (caller should ask).
export async function tryReadPdf(
  bytes: Uint8Array,
  saved: PdfPassword[],
): Promise<UnlockResult | null> {
  if (!(await isEncrypted(bytes))) {
    return { text: await extractPdfText(bytes), password: null, label: null };
  }
  for (const p of saved) {
    try {
      const text = await extractPdfText(bytes, p.password);
      return { text, password: p.password, label: p.label };
    } catch (e) {
      if (isPasswordError(e)) continue; // wrong password, try next
      throw e;
    }
  }
  return null; // encrypted, no known password
}

// Best-effort: remove the password to produce an unprotected PDF for saving.
// Returns null if decryption isn't possible in this runtime (caller saves original).
export async function decryptToUnprotected(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array | null> {
  try {
    // @ts-ignore - untyped remote import
    const createModule = (await import("https://esm.sh/@jspawn/qpdf-wasm@0.0.2?no-dts")).default;
    const mod = await createModule({
      locateFile: (f: string) => `https://esm.sh/@jspawn/qpdf-wasm@0.0.2/dist/${f}`,
    });
    mod.FS.writeFile("in.pdf", bytes);
    mod.callMain([`--password=${password}`, "--decrypt", "in.pdf", "out.pdf"]);
    const out = mod.FS.readFile("out.pdf") as Uint8Array;
    return out?.length ? out : null;
  } catch {
    return null; // fall back to storing the original
  }
}
