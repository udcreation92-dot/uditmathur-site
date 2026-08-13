import { addDays, format } from 'date-fns'

// Parse a natural-language quick-add string into task fields + a human preview.
// Example: "Pay rent tomorrow 9-11am 15m @home every month"
//  -> { title, start_date, due_date, start_time, end_time, duration_minutes,
//       is_recurring, recurrence, locationName, preview }

const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6 }
const MONTHS = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 }

const iso = (d) => format(d, 'yyyy-MM-dd')

function to24(h, m, ap) {
  h = parseInt(h, 10)
  m = m ? parseInt(m, 10) : 0
  if (ap) {
    ap = ap.toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
  }
  if (h > 23 || m > 59) return null
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function nextWeekday(target, forceNext) {
  const now = new Date()
  let delta = (target - now.getDay() + 7) % 7
  if (delta === 0 && forceNext) delta = 7
  return addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), delta)
}

export function parseQuickTask(input) {
  let s = ` ${input} `
  const out = {
    title: '', start_date: null, due_date: null, start_time: null, end_time: null,
    duration_minutes: 0, is_recurring: false, recurrence: null, locationName: null,
  }
  const cut = (re) => { let m; if ((m = s.match(re))) { s = s.replace(m[0], ' '); return m } return null }

  // 1. Location: @name
  const loc = cut(/@([a-z][\w-]*)/i)
  if (loc) out.locationName = loc[1]

  // 2. Recurrence (before dates/times so "every monday" isn't read as a due weekday)
  let rec = cut(/\bevery\s+day\b|\bdaily\b/i)
  if (rec) { out.is_recurring = true; out.recurrence = { frequency: 'daily' } }
  if (!out.is_recurring && (rec = cut(/\bevery\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i))) {
    out.is_recurring = true; out.recurrence = { frequency: 'weekly', days: [WEEKDAYS[rec[1].toLowerCase()]] }
  }
  if (!out.is_recurring && (rec = cut(/\bevery\s+week\b|\bweekly\b/i))) {
    out.is_recurring = true; out.recurrence = { frequency: 'weekly', days: [new Date().getDay()] }
  }
  if (!out.is_recurring && (rec = cut(/\bevery\s+month\b|\bmonthly\b/i))) {
    out.is_recurring = true; out.recurrence = { frequency: 'monthly', day: new Date().getDate() }
  }

  // 3. Times — range first (e.g. 9-11am, 9:30am-11am, 10 to 2pm, 9-5)
  let m = cut(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  if (m) {
    const [, h1, m1, ap1, h2, m2, ap2] = m
    let end = to24(h2, m2, ap2)
    let start
    if (ap1) start = to24(h1, m1, ap1)
    else if (ap2) {
      const same = to24(h1, m1, ap2)          // e.g. "2-3pm" -> both pm
      start = (same && end && same <= end) ? same : to24(h1, m1, 'am') // "10 to 2pm" -> 10am
    } else {
      start = to24(h1, m1)                     // no meridiem: read as 24h
      if (start && end && end < start) end = to24(h2, m2, 'pm') || end  // "9-5" -> 9:00–17:00
    }
    if (start) out.start_time = start
    if (end) out.end_time = end
  }
  // "by 6pm" -> deadline (end_time only)
  if ((m = cut(/\bby\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i))) {
    const en = to24(m[1], m[2], m[3]); if (en) out.end_time = en
  }
  // "at 10am" / standalone "10am" -> start_time
  if (!out.start_time && (m = cut(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) {
    const st = to24(m[1], m[2], m[3]); if (st) out.start_time = st
  }

  // 4. Duration — after times so am/pm's "m" isn't eaten. e.g. 1h30m, 2h, 15m, 90 min
  let mins = 0
  if ((m = cut(/\b(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?\b/i))) {
    mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  } else if ((m = cut(/\b(\d+)\s*h(?:ours?|rs?)?\b/i))) {
    mins = parseInt(m[1], 10) * 60
    const m2 = cut(/\b(\d+)\s*m(?:in(?:ute)?s?)?\b/i); if (m2) mins += parseInt(m2[1], 10)
  } else if ((m = cut(/\b(\d+)\s*m(?:in(?:ute)?s?)?\b/i))) {
    mins = parseInt(m[1], 10)
  }
  out.duration_minutes = mins

  // 5. Dates
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let dateSet = false
  const setDate = (d) => { out.start_date = iso(d); dateSet = true }

  if (cut(/\b(today|tonight|aaj)\b/i)) setDate(today)
  else if (cut(/\b(tomorrow|tom|kal)\b/i)) setDate(addDays(today, 1))
  else if (cut(/\b(day\s*after\s*tomorrow|parso)\b/i)) setDate(addDays(today, 2))
  else if ((m = cut(/\bin\s+(\d+)\s*(?:days?|d)\b/i))) setDate(addDays(today, parseInt(m[1], 10)))
  else if ((m = cut(/\+(\d+)d\b/i))) setDate(addDays(today, parseInt(m[1], 10)))
  else if ((m = cut(/\bnext\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i))) setDate(nextWeekday(WEEKDAYS[m[1].toLowerCase()], true))
  else if (!out.is_recurring && (m = cut(/\b(mon|tue|wed|thu|fri|sat|sun)(?:day|s|nes|rs|urs)?\b/i))) setDate(nextWeekday(WEEKDAYS[m[1].toLowerCase()], false))
  else if ((m = cut(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i)) ||
           (m = cut(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i))) {
    const isDayFirst = /^\d/.test(m[1])
    const day = parseInt(isDayFirst ? m[1] : m[2], 10)
    const mon = MONTHS[(isDayFirst ? m[2] : m[1]).toLowerCase()]
    let d = new Date(now.getFullYear(), mon, day)
    if (d < today) d = new Date(now.getFullYear() + 1, mon, day)
    setDate(d)
  } else if ((m = cut(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const day = parseInt(m[1], 10), mon = parseInt(m[2], 10) - 1
    let year = m[3] ? parseInt(m[3].length === 2 ? '20' + m[3] : m[3], 10) : now.getFullYear()
    let d = new Date(year, mon, day)
    if (!m[3] && d < today) d = new Date(year + 1, mon, day)
    setDate(d)
  }

  // 6. Title = whatever is left
  out.title = s.replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase())

  // If nothing was recognised as a date, leave start_date null (caller defaults to today).
  if (!dateSet) out.start_date = null

  return { ...out, preview: buildPreview(out) }
}

function fmtTime(t) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  const ap = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${ap}`
}
function fmtDur(mins) {
  if (!mins) return null
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60), m = mins % 60
  return m ? `${h}h${m}m` : `${h}h`
}

function buildPreview(o) {
  const bits = []
  if (o.start_date) {
    const d = new Date(o.start_date + 'T00:00:00')
    const t = new Date(); t.setHours(0, 0, 0, 0)
    const diff = Math.round((d - t) / 86400000)
    bits.push(diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : format(d, 'MMM d'))
  }
  if (o.start_time || o.end_time) {
    bits.push([fmtTime(o.start_time), fmtTime(o.end_time)].filter(Boolean).join('–'))
  }
  const dur = fmtDur(o.duration_minutes); if (dur) bits.push(dur)
  if (o.locationName) bits.push('📍' + o.locationName)
  if (o.is_recurring) bits.push('🔁' + (o.recurrence?.frequency || 'recurring'))
  return bits.join(' · ')
}
