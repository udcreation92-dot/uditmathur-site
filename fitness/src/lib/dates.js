// All dates are local 'YYYY-MM-DD' strings — no timezone shifting.
const pad = (n) => String(n).padStart(2, '0')

export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
export const today = () => ymd(new Date())
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d) }
export const monthOf = (s) => s.slice(0, 7)
export const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }
export const daysInMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate() }
export const monthStart = (m) => `${m}-01`
export const monthEnd = (m) => `${m}-${pad(daysInMonth(m))}`
export const monthDays = (m) => Array.from({ length: daysInMonth(m) }, (_, i) => `${m}-${pad(i + 1)}`)

// Monday-based week
export const weekStart = (s) => { const d = parse(s); const dow = (d.getDay() + 6) % 7; return addDays(s, -dow) }
export const weekDays = (s) => { const st = weekStart(s); return Array.from({ length: 7 }, (_, i) => addDays(st, i)) }
export const dow = (s) => (parse(s).getDay() + 6) % 7 // 0 = Monday

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const fmtDay = (s) => { const d = parse(s); return `${DOW[dow(s)]}, ${d.getDate()} ${MON[d.getMonth()]}` }
export const fmtShort = (s) => { if (!s) return '—'; const d = parse(s); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}` }
export const fmtMonth = (m) => { const [y, mo] = m.split('-').map(Number); return `${MON[mo - 1]} ${y}` }

// Weekly check-in buckets like the sheet: Week 1 = days 1–7 … Week 4 = days 22–end
export const weekLabel = (m, i) => `Day ${i * 7 + 1}–${i === 3 ? daysInMonth(m) : i * 7 + 7}`

export const sleepHours = (bed, wake) => {
  if (!bed || !wake) return null
  const [bh, bm] = bed.split(':').map(Number)
  const [wh, wm] = wake.split(':').map(Number)
  let mins = wh * 60 + wm - (bh * 60 + bm)
  if (mins <= 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}
