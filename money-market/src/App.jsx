import { useEffect, useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts'
import { supabase } from './lib/supabase'

// ── palette ───────────────────────────────────────────────────────────────
const C = {
  band:  '#38bdf8',   // corridor fill (sky)
  repo:  '#f59e0b',   // policy repo (amber)
  gsec:  '#34d399',   // G-Sec WAR (emerald)
  corp:  '#fb7185',   // Corp bond WAR (rose)
  spread:'#a78bfa',   // spread (violet)
}

// ── formatters ────────────────────────────────────────────────────────────
const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(2)}%`)
const bps = (n) => (n == null ? '—' : `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(1)} bps`)
const dmy = (iso) => format(parseISO(iso), 'dd MMM')
const crore = (n) => {
  if (n == null) return '—'
  const v = Number(n)
  const sign = v < 0 ? '−' : '+'
  const abs = Math.abs(v)
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)} L Cr`
  return `${sign}₹${abs.toLocaleString('en-IN')} Cr`
}

export default function App() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('money_market_enriched')
        .select('*')
        .order('report_date', { ascending: true })
      if (error) { setErr(error.message); return }
      setRows(data ?? [])
    })()
  }, [])

  const chart = useMemo(() => (rows ?? []).map((r) => ({
    ...r,
    d: r.report_date,
    // range-area value [floor, ceiling] → recharts renders a band between the two
    band: r.sdf_rate != null && r.msf_rate != null ? [r.sdf_rate, r.msf_rate] : null,
  })), [rows])

  // latest row overall, and latest row that actually has a market rate (skip weekends/holidays)
  const latest = rows?.length ? rows[rows.length - 1] : null
  const latestMkt = useMemo(
    () => (rows ?? []).slice().reverse().find((r) => r.gsec_war != null) ?? null,
    [rows],
  )

  const yDomain = useMemo(() => {
    const vals = []
    for (const r of chart) {
      for (const k of ['sdf_rate', 'msf_rate', 'gsec_war', 'corp_bond_war', 'repo_rate']) {
        if (r[k] != null) vals.push(Number(r[k]))
      }
    }
    if (!vals.length) return [4.5, 6]
    // zoom tight to the data (round out to the nearest 0.05) so the corridor fills the panel
    const r = (x, f) => Math[f](x * 20) / 20
    return [r(Math.min(...vals) - 0.1, 'floor'), r(Math.max(...vals) + 0.1, 'ceil')]
  }, [chart])

  const corridorBroken = (rows ?? []).some((r) => r.corridor_ok === false)

  if (err) return <Shell><Card><p className="text-rose-400">Failed to load: {err}</p></Card></Shell>
  if (!rows) return <Shell><p className="text-slate-500">Loading…</p></Shell>

  return (
    <Shell>
      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Kpi label="G-Sec WAR" value={pct(latestMkt?.gsec_war)}
             sub={latestMkt ? `as on ${dmy(latestMkt.report_date)}` : ''} accent={C.gsec} />
        <Kpi label="Corp spread" value={bps(latestMkt?.corp_spread_bps)}
             sub="corp bond over G-Sec" accent={C.spread} />
        <Kpi label="Net liquidity" value={crore(latest?.net_liquidity)}
             sub={latest?.net_liquidity < 0 ? 'absorption' : 'injection'} accent={C.band} />
        <Kpi label="G-Sec vs repo" value={bps(latestMkt?.gsec_vs_repo_bps)}
             sub={latestMkt ? `repo ${pct(latestMkt.repo_rate)}` : ''} accent={C.repo} />
      </div>

      {corridorBroken && (
        <div className="panel border-amber-700/60 bg-amber-950/40 px-4 py-2 mb-4 text-sm text-amber-300">
          ⚠ One or more days have MSF − SDF ≠ 0.50 (corridor flagged). Rows are still stored — check the data.
        </div>
      )}

      {/* Main chart */}
      <Card title="Overnight rates vs policy corridor"
            subtitle="Shaded band = SDF floor → MSF ceiling · dashed = policy repo (stepped on effective date)">
        <div className="h-[380px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="d" tickFormatter={dmy} tick={{ fill: '#64748b', fontSize: 11 }}
                     stroke="#334155" minTickGap={24} />
              <YAxis domain={yDomain} tick={{ fill: '#64748b', fontSize: 11 }} stroke="#334155"
                     tickFormatter={(v) => v.toFixed(2)} width={52} tickCount={7} allowDecimals
                     label={{ value: '%', angle: 0, position: 'top', fill: '#64748b', fontSize: 11 }} />
              <Tooltip content={<RateTip />} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />

              {/* corridor band = range area between SDF (floor) and MSF (ceiling) */}
              <Area dataKey="band" name="Policy corridor (SDF–MSF)" stroke={C.band}
                    strokeOpacity={0.4} strokeWidth={1} fill={C.band} fillOpacity={0.12}
                    connectNulls isAnimationActive={false} activeDot={false} tooltipType="none" />

              <Line type="stepAfter" dataKey="repo_rate" name="Policy repo" stroke={C.repo}
                    strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="gsec_war" name="G-Sec WAR" stroke={C.gsec}
                    strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="corp_bond_war" name="Corp bond WAR" stroke={C.corp}
                    strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Spread panel */}
      <Card title="Corporate-bond risk premium" subtitle="A.IV Repo-in-Corporate-Bond rate minus G-Sec WAR (bps)">
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
              <defs>
                <linearGradient id="spreadFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.spread} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={C.spread} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="d" tickFormatter={dmy} tick={{ fill: '#64748b', fontSize: 11 }}
                     stroke="#334155" minTickGap={24} />
              <YAxis tick={{ fill: '#64748b', fontSize: 11 }} stroke="#334155" width={40}
                     tickFormatter={(v) => `${v}`} />
              <Tooltip content={<SpreadTip />} />
              <Area type="monotone" dataKey="corp_spread_bps" name="Corp spread (bps)" stroke={C.spread}
                    strokeWidth={2} fill="url(#spreadFill)" connectNulls={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <RecentTable rows={rows} />
        <RepoEntry />
      </div>

      <footer className="text-center text-xs text-slate-600 mt-6 pb-safe">
        Source: RBI daily “Money Market Operations” press releases · auto-ingested every working morning
      </footer>
    </Shell>
  )
}

// ── layout bits ─────────────────────────────────────────────────────────────
function Shell({ children }) {
  return (
    <div className="min-h-screen max-w-5xl mx-auto px-4 py-5">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-slate-50 flex items-center gap-2">
            <span>📊</span> RBI Money Market Monitor
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">Overnight G-Sec market rate vs the policy corridor</p>
        </div>
        <a href="/" className="text-xs text-slate-400 hover:text-slate-200 border border-slate-800 rounded-lg px-3 py-1.5">← Home</a>
      </header>
      {children}
    </div>
  )
}

function Card({ title, subtitle, children }) {
  return (
    <section className="panel p-4 mb-4">
      {title && <h2 className="text-sm font-semibold text-slate-200">{title}</h2>}
      {subtitle && <p className="text-xs text-slate-500 mb-3">{subtitle}</p>}
      {children}
    </section>
  )
}

function Kpi({ label, value, sub, accent }) {
  return (
    <div className="kpi" style={{ borderTopColor: accent, borderTopWidth: 3 }}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  )
}

// ── tooltips ─────────────────────────────────────────────────────────────────
function RateTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const r = payload[0].payload
  const line = (k, name, fmt) => (
    <div className="flex justify-between gap-4"><span className="text-slate-400">{name}</span>
      <span className="tabular-nums text-slate-100">{fmt(r[k])}</span></div>
  )
  return (
    <div className="panel px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold text-slate-200 mb-1">{dmy(label)}</div>
      {line('gsec_war', 'G-Sec WAR', pct)}
      {line('corp_bond_war', 'Corp bond WAR', pct)}
      {line('repo_rate', 'Policy repo', pct)}
      {line('sdf_rate', 'SDF floor', pct)}
      {line('msf_rate', 'MSF ceiling', pct)}
      {r.corridor_ok === false && <div className="text-amber-400 mt-1">⚠ corridor ≠ 0.50</div>}
    </div>
  )
}

function SpreadTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const r = payload[0].payload
  return (
    <div className="panel px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold text-slate-200 mb-1">{dmy(label)}</div>
      <div className="flex justify-between gap-4"><span className="text-slate-400">Corp spread</span>
        <span className="tabular-nums text-slate-100">{bps(r.corp_spread_bps)}</span></div>
    </div>
  )
}

// ── recent-days table ────────────────────────────────────────────────────────
function RecentTable({ rows }) {
  const recent = rows.slice(-8).reverse()
  const cell = 'px-2 py-1.5 tabular-nums'
  return (
    <Card title="Recent working days">
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 text-left">
              <th className="px-2 py-1 font-medium">Date</th>
              <th className="px-2 py-1 font-medium text-right">G-Sec</th>
              <th className="px-2 py-1 font-medium text-right">Corp</th>
              <th className="px-2 py-1 font-medium text-right">Spread</th>
              <th className="px-2 py-1 font-medium text-right">Net liq.</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.report_date} className="border-t border-slate-800/70">
                <td className={cell}>{dmy(r.report_date)}</td>
                <td className={`${cell} text-right`} style={{ color: C.gsec }}>{pct(r.gsec_war)}</td>
                <td className={`${cell} text-right`} style={{ color: C.corp }}>{pct(r.corp_bond_war)}</td>
                <td className={`${cell} text-right`}>{r.corp_spread_bps == null ? '—' : `${r.corp_spread_bps}`}</td>
                <td className={`${cell} text-right text-slate-400`}>{crore(r.net_liquidity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ── repo-rate manual entry → generates a safe SQL snippet (public app has read-only RLS) ──
function RepoEntry() {
  const [date, setDate] = useState('')
  const [rate, setRate] = useState('')
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)

  const sql = `insert into public.repo_rate_history (effective_from, repo_rate, note)\nvalues ('${date || 'YYYY-MM-DD'}', ${rate || '0.00'}, '${(note || '').replace(/'/g, "''")}')\non conflict (effective_from) do update set repo_rate = excluded.repo_rate, note = excluded.note;`

  const copy = async () => {
    try { await navigator.clipboard.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  return (
    <Card title="Add / change policy repo rate"
          subtitle="When the MPC changes the repo rate, add a row. This app is read-only, so it generates SQL to run in the Supabase SQL editor.">
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <label className="lbl">Effective from</label>
          <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="lbl">Repo rate (%)</label>
          <input type="number" step="0.05" placeholder="5.50" className="field" value={rate} onChange={(e) => setRate(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="lbl">Note (optional)</label>
          <input type="text" placeholder="MPC Aug 2026 — 25 bps cut" className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-[0.7rem] text-slate-300 overflow-x-auto whitespace-pre-wrap">{sql}</pre>
      <button onClick={copy} className="mt-2 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-lg px-3 py-1.5">
        {copied ? '✓ Copied' : 'Copy SQL'}
      </button>
    </Card>
  )
}
