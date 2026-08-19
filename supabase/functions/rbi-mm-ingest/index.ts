// RBI Money Market Monitor — ingestion edge function
//
// Modes (query params):
//   ?secret=<SHARED_SECRET>              required for every call
//   (default)                            daily: ingest the topmost NEW "Money Market
//                                        Operations" release; skip cleanly if already stored
//   ?mode=backfill&days=30               walk recent releases, ingest up to `days` of them
//   ?prid=63391                          ingest one specific release (testing / manual)
//   ?dry=1                               parse + compute but DON'T write (returns the row)
//
// The function fetches the RBI landing page, finds the release link, fetches the detail
// HTML table, parses the Overnight Segment + SDF/MSF + net liquidity, computes the
// G-Sec WAR / corp spread / corridor check, and upserts one idempotent row keyed on
// report_date. Writes use the service-role key (bypasses RLS).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared secret gate (function is deployed with verify_jwt=false so pg_cron can call it
// without minting a JWT). Rotate by redeploying with a new value + updating the cron job.
const SHARED_SECRET = "rbi_mm_9f3c7a21e6b04d58";

const LANDING = "https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx";
const DETAIL = (prid: string) =>
  `https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=${prid}`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ── HTTP fetch with fallback: try a bare request first, then a realistic UA. ──────────
async function fetchRbi(url: string): Promise<{ html: string; path: string }> {
  // Path 1: direct fetch, no special headers.
  try {
    const r = await fetch(url, { redirect: "follow" });
    const t = await r.text();
    if (r.ok && t.length > 2000 && t.includes("PressRelease")) {
      return { html: t, path: "direct" };
    }
  } catch (_) { /* fall through */ }

  // Path 2: realistic User-Agent (old ASP.NET site often rejects bare requests).
  const r2 = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const t2 = await r2.text();
  if (r2.ok && t2.length > 2000) return { html: t2, path: "user-agent" };

  throw new Error(`RBI fetch failed for ${url} (status ${r2.status}, ${t2.length} bytes)`);
}

// ── Parsing helpers ───────────────────────────────────────────────────────────────────
function parseNum(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = s.replace(/&nbsp;/g, " ").trim();
  if (t === "" || t === "-" || t === "—") return null;
  const n = parseFloat(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isoFromHeaderDate(monthName: string, day: string, year: string): string | null {
  const mm = MONTHS[monthName.toLowerCase()];
  if (!mm) return null;
  return `${year}-${mm}-${String(parseInt(day, 10)).padStart(2, "0")}`;
}

// Volume + rate for an overnight-segment row anchored on its unique <th id="...">.
// We anchor on the id (OSCallMoney/OSTriparty/OSMarket/OSRepoCP) rather than the
// `headers` attr because RBI mistakenly reuses the overnight `headers` value on some
// Term-segment rows. Overnight only — Term Segment is never read.
function overnightRow(html: string, thId: string): { vol: number | null; rate: number | null } {
  const re = new RegExp(
    `id="${thId}"[^>]*>[\\s\\S]*?<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
    "i",
  );
  const m = html.match(re);
  if (!m) return { vol: null, rate: null };
  return { vol: parseNum(m[1]), rate: parseNum(m[2]) };
}

// A LAF cell (SDF/MSF rate, net liquidity) anchored on its stable `headers` attribute,
// scoped to "Today's Operations" so the blank Outstanding-Operations rows are ignored.
function todayCell(html: string, seg: string, col: string): number | null {
  const re = new RegExp(
    `headers="[^"]*TodaysOperations ${seg} ${col}"[^>]*>([\\s\\S]*?)<\\/td>`,
    "i",
  );
  const m = html.match(re);
  return m ? parseNum(m[1]) : null;
}

export interface ParsedRow {
  report_date: string;
  call_money_vol: number | null; call_money_rate: number | null;
  triparty_vol: number | null; triparty_rate: number | null;
  market_repo_vol: number | null; market_repo_rate: number | null;
  corp_bond_vol: number | null; corp_bond_rate: number | null;
  gsec_war: number | null; corp_bond_war: number | null; corp_spread_bps: number | null;
  sdf_rate: number | null; msf_rate: number | null;
  net_liquidity: number | null;
  corridor_ok: boolean;
  source_prid: string | null;
}

export function parseDetail(html: string, prid: string | null): ParsedRow {
  // Report date from the "Money Market Operations as on <Month DD, YYYY>" header.
  const dm = html.match(
    /Money Market Operations as on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i,
  );
  if (!dm) throw new Error("could not find report date header");
  const report_date = isoFromHeaderDate(dm[1], dm[2], dm[3]);
  if (!report_date) throw new Error(`bad month name: ${dm[1]}`);

  const call = overnightRow(html, "OSCallMoney");
  const tri = overnightRow(html, "OSTriparty");
  const mkt = overnightRow(html, "OSMarket");
  const corp = overnightRow(html, "OSRepoCP");

  const sdf_rate = todayCell(html, "SDF", "CurrentRateCutOffRate");
  const msf_rate = todayCell(html, "MSF", "CurrentRateCutOffRate");
  const net_liquidity = todayCell(html, "Netliquidityinjected", "Amount");

  // G-Sec WAR = vol-weighted avg of Call + Triparty + Market Repo (overnight only).
  // A.IV Repo in Corporate Bond is EXCLUDED (tracked as its own risk-premium line).
  let gsec_war: number | null = null;
  const parts = [call, tri, mkt];
  if (parts.every((p) => p.vol != null && p.rate != null)) {
    const num = parts.reduce((s, p) => s + (p.vol! * p.rate!), 0);
    const den = parts.reduce((s, p) => s + p.vol!, 0);
    gsec_war = den > 0 ? Math.round((num / den) * 10000) / 10000 : null;
  }

  const corp_bond_war = corp.rate;
  const corp_spread_bps =
    gsec_war != null && corp_bond_war != null
      ? Math.round((corp_bond_war - gsec_war) * 100 * 10) / 10
      : null;

  // Corridor sanity: MSF - SDF should equal 0.50. Flag but still store when it isn't.
  const corridor_ok =
    sdf_rate != null && msf_rate != null
      ? Math.abs((msf_rate - sdf_rate) - 0.5) < 1e-9
      : false;

  return {
    report_date,
    call_money_vol: call.vol, call_money_rate: call.rate,
    triparty_vol: tri.vol, triparty_rate: tri.rate,
    market_repo_vol: mkt.vol, market_repo_rate: mkt.rate,
    corp_bond_vol: corp.vol, corp_bond_rate: corp.rate,
    gsec_war, corp_bond_war, corp_spread_bps,
    sdf_rate, msf_rate, net_liquidity,
    corridor_ok,
    source_prid: prid,
  };
}

// Collect { prid, date } for every "Money Market Operations as on ..." link on the
// landing page, topmost (most recent) first.
function landingLinks(html: string): { prid: string; report_date: string }[] {
  const re =
    /<a[^>]*prid=(\d+)[^>]*>\s*Money Market Operations as on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/gi;
  const out: { prid: string; report_date: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const d = isoFromHeaderDate(m[2], m[3], m[4]);
    if (d) out.push({ prid: m[1], report_date: d });
  }
  return out;
}

// ── Main handler ────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const dry = url.searchParams.get("dry") === "1";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const log: string[] = [];
  async function ingestPrid(prid: string, knownDate?: string) {
    const { html, path } = await fetchRbi(DETAIL(prid));
    log.push(`prid ${prid}: fetched via ${path} (${html.length} bytes)`);
    const row = parseDetail(html, prid);
    if (knownDate && row.report_date !== knownDate) {
      log.push(`prid ${prid}: date mismatch (link ${knownDate} vs page ${row.report_date}) — using page`);
    }
    if (dry) return { row, wrote: false };
    const { error } = await supabase
      .from("money_market_daily")
      .upsert(row, { onConflict: "report_date" });
    if (error) throw new Error(`upsert failed for ${row.report_date}: ${error.message}`);
    return { row, wrote: true };
  }

  try {
    // Single-page mode (testing / manual).
    const one = url.searchParams.get("prid");
    if (one) {
      const res = await ingestPrid(one);
      return json({ ok: true, mode: "prid", log, ...res });
    }

    const mode = url.searchParams.get("mode") ?? "daily";
    const { html, path } = await fetchRbi(LANDING);
    log.push(`landing: fetched via ${path} (${html.length} bytes)`);
    const links = landingLinks(html);
    log.push(`landing: found ${links.length} MMO links; latest = ${links[0]?.report_date ?? "none"}`);
    if (links.length === 0) return json({ ok: true, mode, skipped: true, reason: "no MMO links found", log });

    if (mode === "backfill") {
      const days = Math.min(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 60);
      const targets = links.slice(0, days);
      const results: unknown[] = [];
      for (const t of targets) {
        try {
          const r = await ingestPrid(t.prid, t.report_date);
          results.push({ prid: t.prid, report_date: r.row.report_date, gsec_war: r.row.gsec_war, wrote: r.wrote });
        } catch (e) {
          results.push({ prid: t.prid, report_date: t.report_date, error: String(e) });
        }
      }
      return json({ ok: true, mode: "backfill", count: results.length, log, results });
    }

    // Daily mode: topmost link only, skip if we already stored that date.
    const latest = links[0];
    const { data: existing } = await supabase
      .from("money_market_daily")
      .select("report_date")
      .eq("report_date", latest.report_date)
      .maybeSingle();
    if (existing) {
      return json({ ok: true, mode: "daily", skipped: true, reason: `already have ${latest.report_date}`, log });
    }
    const res = await ingestPrid(latest.prid, latest.report_date);
    return json({ ok: true, mode: "daily", log, row: res.row });
  } catch (e) {
    log.push(`ERROR: ${String(e)}`);
    return json({ ok: false, error: String(e), log }, 500);
  }
});
