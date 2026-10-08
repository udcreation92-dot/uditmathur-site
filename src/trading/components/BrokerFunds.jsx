import { useState, useEffect, useCallback, Fragment } from "react";
import { api } from "../api";

// Consolidated Funds & Margin card for all three brokers. Standardized columns:
//   Cash + Pledged Collateral = Total ; Available = Total − Utilized (consistent everywhere).
// Fyers is always connected here (the whole app is gated behind Fyers login), so its row just
// shows funds + logout; Zerodha connects via OAuth redirect; Shoonya via the paste-code flow.
const BROKERS = [
  {
    id: "fyers", label: "FYERS", dot: "bg-gray-300", name: "text-gray-200", gate: true,
    statusFn: () => api.authStatus(), fundsFn: () => api.getFunds(),
    loginUrlFn: () => api.getLoginUrl(), logoutFn: () => api.logout(), connect: "redirect",
  },
  {
    id: "zerodha", label: "ZERODHA", dot: "bg-blue-400", name: "text-blue-400",
    statusFn: () => api.zerodhaAuthStatus(), fundsFn: () => api.zerodhaGetFunds(),
    loginUrlFn: () => api.zerodhaGetLoginUrl(), logoutFn: () => api.zerodhaLogout(), connect: "redirect",
  },
  {
    id: "shoonya", label: "SHOONYA", dot: "bg-orange-400", name: "text-orange-400",
    statusFn: () => api.shoonyaAuthStatus(), fundsFn: () => api.shoonyaGetFunds(),
    loginUrlFn: () => api.shoonyaGetLoginUrl(), callbackFn: (c) => api.shoonyaAuthCallback(c),
    logoutFn: () => api.shoonyaLogout(), connect: "paste",
  },
];

const num = (n) => Number(n) || 0;
const fmtR = (n) => "₹" + Math.round(num(n)).toLocaleString("en-IN");
const fmtL = (n) => (Math.abs(num(n)) >= 100000 ? "₹" + (num(n) / 100000).toFixed(2) + "L" : fmtR(n));
const utilText = (p) => (p > 80 ? "text-red-400" : p >= 50 ? "text-amber-400" : "text-green-400");
const utilFill = (p) => (p > 80 ? "bg-red-500" : p >= 50 ? "bg-amber-500" : "bg-green-500");

// Live TOTP for a broker login — shows the current 2FA code + a shrinking timer, click to copy.
function TotpChip({ broker }) {
  const [totp, setTotp] = useState(null);   // { code, remaining, account }
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true, timer;
    const tick = () => api.getTotp(broker)
      .then(t => { if (!alive) return; setTotp(t); timer = setTimeout(tick, (t.remaining || 30) * 1000 + 300); })
      .catch(() => { if (alive) timer = setTimeout(tick, 5000); });
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [broker]);

  // local 1s countdown between server refreshes
  useEffect(() => {
    if (!totp) return;
    const id = setInterval(() => setTotp(t => t && t.remaining > 0 ? { ...t, remaining: t.remaining - 1 } : t), 1000);
    return () => clearInterval(id);
  }, [totp?.code]);

  if (!totp) return null;
  const copy = () => { navigator.clipboard?.writeText(totp.code); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <button onClick={copy} title={`TOTP for ${totp.account} — click to copy, then paste on the broker login page`}
      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded font-mono">
      <span className="text-gray-500">OTP</span>
      <span className="text-amber-300 tracking-wider font-semibold">{totp.code}</span>
      <span className={`tabular-nums ${totp.remaining <= 5 ? "text-red-400" : "text-gray-500"}`}>{totp.remaining}s</span>
      <span className="text-blue-300">{copied ? "✓" : "copy"}</span>
    </button>
  );
}

function CopyIpButton({ ip, copied, setCopied }) {
  return (
    <button onClick={() => { navigator.clipboard?.writeText(ip); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="text-[10px] px-2 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-200">
      {copied ? "copied ✓" : "copy IP"}
    </button>
  );
}

function UtilCell({ utilized, total }) {
  const pct = total > 0 ? (utilized / total) * 100 : 0;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-12 h-1.5 bg-gray-700 rounded overflow-hidden">
        <div className={`h-full ${utilFill(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={`tabular-nums ${utilText(pct)}`}>{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function BrokerFunds() {
  const [rows, setRows] = useState({}); // id -> { connected, funds }
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState({}); // id -> bool (connect/logout in flight)
  const [errors, setErrors] = useState({});
  const [paste, setPaste] = useState({ show: false, value: "" });
  const [ipGuard, setIpGuard] = useState(null); // { current_ip, last_ok_ip, changed, logged_in }
  const [copied, setCopied] = useState(false);

  const loadFunds = useCallback(async (broker, connected) => {
    if (!connected) {
      setRows((r) => ({ ...r, [broker.id]: { connected: false, funds: null } }));
      return;
    }
    try {
      const funds = await broker.fundsFn();
      setRows((r) => ({ ...r, [broker.id]: { connected: true, funds } }));
    } catch {
      setRows((r) => ({ ...r, [broker.id]: { connected: true, funds: null } }));
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    await Promise.all(
      BROKERS.map(async (b) => {
        try {
          const { logged_in } = await b.statusFn();
          await loadFunds(b, logged_in);
        } catch {
          setRows((r) => ({ ...r, [b.id]: { connected: false, funds: null } }));
        }
      })
    );
    // Shoonya home-IP drift guard — Shoonya is IPv4-only and can't use the proxy, so its whitelist
    // must track the (dynamic) home IP. Surfaces a heads-up if the IP drifted while disconnected.
    api.shoonyaIpGuard().then(setIpGuard).catch(() => {});
  }, [loadFunds]);

  // Handle OAuth redirect returns (?fyers_login / ?zerodha_login / ?shoonya_login) surfaced by
  // the backend redirect handlers, then check status.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    for (const key of ["fyers_login", "zerodha_login", "shoonya_login"]) {
      if (params.has(key)) {
        if (params.get(key) === "error") {
          const b = key.split("_")[0];
          setErrors((e) => ({ ...e, [b]: `${b} login failed — try again.` }));
        }
        params.delete(key);
      }
    }
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    refreshStatus();
  }, [refreshStatus]);

  // Poll funds for connected brokers every 10s (status is only re-checked on connect/logout).
  useEffect(() => {
    const id = setInterval(() => {
      for (const b of BROKERS) {
        const row = rows[b.id];
        if (row?.connected) loadFunds(b, true);
      }
    }, 10000);
    return () => clearInterval(id);
  }, [rows, loadFunds]);

  async function connect(broker) {
    setErrors((e) => ({ ...e, [broker.id]: null }));
    setBusy((b) => ({ ...b, [broker.id]: true }));
    try {
      const { url } = await broker.loginUrlFn();
      if (broker.connect === "paste") {
        window.open(url, "_blank", "noopener");
        setPaste({ show: true, value: "" });
      } else {
        window.location.href = url;
        return;
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [broker.id]: err.message }));
    } finally {
      setBusy((b) => ({ ...b, [broker.id]: false }));
    }
  }

  function extractCode(v) {
    const s = (v || "").trim();
    const m = s.match(/[?&]code=([^&\s]+)/);
    return m ? decodeURIComponent(m[1]) : s;
  }

  async function submitShoonyaCode() {
    const broker = BROKERS.find((b) => b.id === "shoonya");
    const code = extractCode(paste.value);
    if (!code) { setErrors((e) => ({ ...e, shoonya: "Paste the code or redirected URL first." })); return; }
    setBusy((b) => ({ ...b, shoonya: true }));
    try {
      await broker.callbackFn(code);
      setPaste({ show: false, value: "" });
      await loadFunds(broker, true);
      setRows((r) => ({ ...r, shoonya: { connected: true, funds: r.shoonya?.funds } }));
    } catch (err) {
      setErrors((e) => ({ ...e, shoonya: err.message }));
    } finally {
      setBusy((b) => ({ ...b, shoonya: false }));
    }
  }

  // One-click automated Shoonya login (headless Playwright on the box) so the user can re-connect
  // after re-whitelisting their IP WITHOUT opening Claude. ONE attempt per click — never auto-retries,
  // because repeated failed Shoonya logins lock the account; the user decides whether to click again.
  async function autoLoginShoonya() {
    setErrors((e) => ({ ...e, shoonya: null }));
    setBusy((b) => ({ ...b, shoonya: true }));
    try {
      const r = await api.shoonyaAutoLogin();
      if (r?.ok) {
        const broker = BROKERS.find((b) => b.id === "shoonya");
        await loadFunds(broker, true);
        setRows((rw) => ({ ...rw, shoonya: { connected: true, funds: rw.shoonya?.funds } }));
        api.shoonyaIpGuard().then(setIpGuard).catch(() => {});
      } else {
        setErrors((e) => ({ ...e, shoonya: (r?.message || "login did not complete") + ". Don't spam — one try per IP change." }));
      }
    } catch (err) {
      setErrors((e) => ({ ...e, shoonya: err.message }));
    } finally {
      setBusy((b) => ({ ...b, shoonya: false }));
    }
  }

  async function logout(broker) {
    if (!confirm(`Log out of ${broker.label}?`)) return;
    setBusy((b) => ({ ...b, [broker.id]: true }));
    try {
      await broker.logoutFn();
      if (broker.gate) { window.location.reload(); return; } // Fyers gates the whole app
      setRows((r) => ({ ...r, [broker.id]: { connected: false, funds: null } }));
    } catch (err) {
      setErrors((e) => ({ ...e, [broker.id]: err.message }));
    } finally {
      setBusy((b) => ({ ...b, [broker.id]: false }));
    }
  }

  const connected = BROKERS.map((b) => ({ b, f: rows[b.id]?.funds })).filter((x) => x.f);
  const totals = connected.reduce(
    (a, { f }) => ({
      cash: a.cash + num(f.cash), collateral: a.collateral + num(f.collateral),
      utilized: a.utilized + num(f.utilized), available: a.available + num(f.available),
      total: a.total + num(f.total),
    }),
    { cash: 0, collateral: 0, utilized: 0, available: 0, total: 0 }
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg mb-4 overflow-x-auto">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wide">Funds &amp; Margin</h3>
        <span className="text-[10px] text-gray-500">Cash + Collateral = Total · Available = Total − Utilized</span>
      </div>

      <table className="w-full text-xs min-w-[720px]">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="text-left py-1.5 px-3 font-medium">Broker</th>
            <th className="text-right px-3 font-medium">Cash</th>
            <th className="text-right px-3 font-medium">Collateral</th>
            <th className="text-right px-3 font-medium">Utilized</th>
            <th className="text-right px-3 font-medium">Util %</th>
            <th className="text-right px-3 font-medium">Available</th>
            <th className="text-right px-3 font-medium">Total</th>
            <th className="px-2"></th>
          </tr>
        </thead>
        <tbody>
          {BROKERS.map((b) => {
            const row = rows[b.id];
            const f = row?.funds;
            const err = errors[b.id];
            const isOpen = expanded === b.id;
            return (
              <Fragment key={b.id}>
                <tr className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="py-2 px-3 whitespace-nowrap">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle ${row?.connected ? b.dot : "bg-gray-600"}`} />
                    <span className={`font-semibold ${b.name}`}>{b.label}</span>
                  </td>
                  {f ? (
                    <>
                      <td className="text-right px-3 text-gray-300 tabular-nums">{fmtR(f.cash)}</td>
                      <td className="text-right px-3 text-gray-300 tabular-nums">{fmtR(f.collateral)}</td>
                      <td className="text-right px-3 text-yellow-400 tabular-nums">{fmtR(f.utilized)}</td>
                      <td className="text-right px-3"><UtilCell utilized={num(f.utilized)} total={num(f.total)} /></td>
                      <td className="text-right px-3 text-green-400 font-semibold tabular-nums">{fmtR(f.available)}</td>
                      <td className="text-right px-3 text-gray-200 font-semibold tabular-nums" title={fmtR(f.total)}>{fmtL(f.total)}</td>
                      <td className="px-2 text-right whitespace-nowrap">
                        <button onClick={() => setExpanded(isOpen ? null : b.id)}
                          className="text-gray-500 hover:text-gray-300 px-1" title="Details">{isOpen ? "▲" : "▾"}</button>
                        <button onClick={() => logout(b)} disabled={busy[b.id]}
                          className="text-[10px] text-gray-500 hover:text-red-400 ml-1 disabled:opacity-50">Logout</button>
                      </td>
                    </>
                  ) : (
                    <td colSpan={7} className="px-3 py-2">
                      {b.id === "shoonya" && paste.show ? (
                        <div className="flex flex-col gap-2">
                          {ipGuard?.changed && ipGuard.current_ip && (
                            <div className="flex flex-wrap items-center gap-2 bg-amber-900/25 border border-amber-800 rounded px-2 py-1.5 text-[11px]">
                              <span className="text-amber-300 font-semibold">⚠ IP changed: whitelist <span className="text-amber-200 tabular-nums">{ipGuard.current_ip}</span> as Shoonya Primary IP first</span>
                              <span className="text-gray-500">(was {ipGuard.last_ok_ip}) — else this code will fail with INVALID_IP.</span>
                              <CopyIpButton ip={ipGuard.current_ip} copied={copied} setCopied={setCopied} />
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] text-gray-500">After logging in (new tab), paste the URL/code:</span>
                            <input value={paste.value} onChange={(e) => setPaste((p) => ({ ...p, value: e.target.value }))}
                              onKeyDown={(e) => e.key === "Enter" && submitShoonyaCode()}
                              placeholder="…?code=xxxx" className="flex-1 min-w-[200px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100" />
                            <button onClick={submitShoonyaCode} disabled={busy.shoonya || !paste.value.trim()}
                              className="text-xs px-3 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded font-medium">
                              {busy.shoonya ? "Connecting…" : "Submit"}
                            </button>
                            <TotpChip broker="shoonya" />
                            {err && <span className="text-red-400 text-[11px]">{err}</span>}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-gray-500">Not connected.</span>
                            <button onClick={() => connect(b)} disabled={busy[b.id]}
                              className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded font-medium disabled:opacity-50">
                              {busy[b.id] ? "…" : `Connect ${b.label.charAt(0) + b.label.slice(1).toLowerCase()}`}
                            </button>
                            {b.id === "shoonya" && (
                              <button onClick={autoLoginShoonya} disabled={busy.shoonya}
                                title="Logs in Shoonya automatically (headless) — use after you've re-whitelisted your IP. One attempt per click."
                                className="text-xs px-3 py-1 bg-orange-600 hover:bg-orange-700 border border-orange-500 rounded font-medium disabled:opacity-50">
                                {busy.shoonya ? "Logging in…" : "⚡ Auto-login"}
                              </button>
                            )}
                            {(b.id === "zerodha" || b.id === "shoonya") && <TotpChip broker={b.id} />}
                            {err && <span className="text-red-400 text-[11px]">{err}</span>}
                          </div>
                          {b.id === "shoonya" && ipGuard?.current_ip && (
                            ipGuard.changed ? (
                              <div className="flex flex-wrap items-center gap-2 bg-amber-900/25 border border-amber-800 rounded px-2 py-1.5 text-[11px]">
                                <span className="text-amber-300 font-semibold">⚠ Your IP changed since Shoonya last worked</span>
                                <span className="text-gray-400">was <span className="text-gray-300 tabular-nums">{ipGuard.last_ok_ip}</span> → now <span className="text-amber-200 font-semibold tabular-nums">{ipGuard.current_ip}</span>.</span>
                                <span className="text-gray-400">Whitelist the new IP as Shoonya <b>Primary IP</b> before connecting.</span>
                                <CopyIpButton ip={ipGuard.current_ip} copied={copied} setCopied={setCopied} />
                              </div>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                                <span>Shoonya sees IP <span className="text-gray-300 tabular-nums">{ipGuard.current_ip}</span> — make sure it's whitelisted as Primary IP.</span>
                                <CopyIpButton ip={ipGuard.current_ip} copied={copied} setCopied={setCopied} />
                              </div>
                            )
                          )}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
                {isOpen && f && (
                  <tr className="bg-gray-800/40 border-b border-gray-800">
                    <td colSpan={8} className="px-4 py-2 text-[11px] text-gray-400">
                      Available shown = Total − Utilized ({fmtR(f.available)}).
                      {f.native_available != null && (
                        <> Broker's own reported available: <span className="text-gray-200">{fmtR(f.native_available)}</span>
                          {" "}(differs by broker-specific buckets like receivables/adhoc, not counted in this standardized view).</>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}

          {connected.length > 1 && (
            <tr className="border-t border-gray-700 bg-gray-800/20 font-semibold">
              <td className="py-2 px-3 text-gray-200">All brokers</td>
              <td className="text-right px-3 text-gray-300 tabular-nums">{fmtR(totals.cash)}</td>
              <td className="text-right px-3 text-gray-300 tabular-nums">{fmtR(totals.collateral)}</td>
              <td className="text-right px-3 text-yellow-400 tabular-nums">{fmtR(totals.utilized)}</td>
              <td className="text-right px-3"><UtilCell utilized={totals.utilized} total={totals.total} /></td>
              <td className="text-right px-3 text-green-400 tabular-nums">{fmtR(totals.available)}</td>
              <td className="text-right px-3 text-gray-100 tabular-nums" title={fmtR(totals.total)}>{fmtL(totals.total)}</td>
              <td className="px-2"></td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
