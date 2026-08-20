import { isToday, parseISO, startOfDay, isAfter } from 'date-fns'

// A monthly recurrence can be a single day {day:X} OR a day RANGE {start_day, due_day}
// (e.g. GST filing: available the 16th, deadline the 20th, every month).
export function isMonthlyWindow(rec) {
  return !!rec && rec.frequency === 'monthly' && rec.start_day != null && rec.due_day != null
}
// The current-or-most-recent monthly cycle's window [from, due] for a day-range recurrence.
function monthlyWindowCycle(rec, now) {
  const off = now.getDate() < rec.start_day ? -1 : 0
  const from = startOfDay(new Date(now.getFullYear(), now.getMonth() + off, rec.start_day))
  const due = startOfDay(new Date(now.getFullYear(), now.getMonth() + off, rec.due_day))
  return { from, due }
}
function completedOnOrAfter(task, from) {
  const lc = task.last_completed_at ? startOfDay(new Date(task.last_completed_at)) : null
  return !!lc && !isAfter(from, lc) // lc >= from
}
function taskEarliest(task) {
  if (task.start_date) return startOfDay(parseISO(task.start_date))
  if (task.created_at) return startOfDay(new Date(task.created_at))
  return null
}

export function isRecurringTaskDue(task) {
  if (!task.is_recurring || !task.recurrence) return false

  const now = new Date()
  const rec = task.recurrence
  const today = startOfDay(now)

  // Monthly day-range: available while today is within [from, due] and not done this cycle.
  if (isMonthlyWindow(rec)) {
    const { from, due } = monthlyWindowCycle(rec, now)
    if (completedOnOrAfter(task, from)) return false
    return !isAfter(from, today) && !isAfter(today, due)
  }

  const lastCompleted = task.last_completed_at ? new Date(task.last_completed_at) : null

  // Already completed today — hide it
  if (lastCompleted && isToday(lastCompleted)) return false

  // Check if today is a scheduled day (no time check — time handled by isCurrentlyActive/isOverdueNow)
  switch (rec.frequency) {
    case 'daily':   return true
    case 'alternate': {
      // Every other day from the anchor (start date). Due on days with even offset.
      if (!rec.anchor) return true
      const anchor = startOfDay(parseISO(rec.anchor))
      const today = startOfDay(now)
      if (isAfter(anchor, today)) return false
      return Math.round((today - anchor) / 86400000) % 2 === 0
    }
    case 'weekly':  return (rec.days || []).includes(now.getDay())
    case 'monthly': return now.getDate() === rec.day
    case 'yearly':  return now.getMonth() + 1 === rec.month && now.getDate() === rec.day
    default:        return false
  }
}

// The most recent scheduled occurrence of a recurring task, on or before today (startOfDay), or null.
function lastScheduledOccurrence(task) {
  const rec = task.recurrence
  if (!rec) return null
  const now = new Date()
  const today = startOfDay(now)

  if (isMonthlyWindow(rec)) return monthlyWindowCycle(rec, now).due // the cycle's deadline day

  switch (rec.frequency) {
    case 'daily':
      return today
    case 'alternate': {
      const anchor = rec.anchor ? startOfDay(parseISO(rec.anchor)) : today
      if (isAfter(anchor, today)) return null
      const diff = Math.round((today - anchor) / 86400000)
      const back = diff % 2 === 0 ? 0 : 1 // if today isn't an "on" day, the last one was yesterday
      const d = new Date(today)
      d.setDate(today.getDate() - back)
      return startOfDay(d)
    }
    case 'weekly': {
      const days = rec.days || []
      if (!days.length) return null
      for (let back = 0; back < 7; back++) {
        const d = new Date(today)
        d.setDate(today.getDate() - back)
        if (days.includes(d.getDay())) return startOfDay(d)
      }
      return null
    }
    case 'monthly': {
      const day = rec.day
      const occ = now.getDate() >= day
        ? new Date(now.getFullYear(), now.getMonth(), day)
        : new Date(now.getFullYear(), now.getMonth() - 1, day)
      return startOfDay(occ)
    }
    case 'yearly': {
      const month = (rec.month || 1) - 1
      let occ = new Date(now.getFullYear(), month, rec.day)
      if (isAfter(startOfDay(occ), today)) occ = new Date(now.getFullYear() - 1, month, rec.day)
      return startOfDay(occ)
    }
    default:
      return null
  }
}

// A recurring task is "missed" if its most recent scheduled occurrence was on a PAST day
// and it has not been completed on/after that occurrence. It keeps nagging (overdue + visible)
// until the user completes it, or until the next occurrence arrives (which resets it).
export function isRecurringMissed(task) {
  if (!task.is_recurring || !task.recurrence) return false
  const now = new Date()
  const today = startOfDay(now)

  // Monthly day-range: missed once the due day has passed without completion this cycle.
  if (isMonthlyWindow(task.recurrence)) {
    const { from, due } = monthlyWindowCycle(task.recurrence, now)
    if (!isAfter(today, due)) return false            // still within / at the window
    if (completedOnOrAfter(task, from)) return false  // done this cycle
    const earliest = taskEarliest(task)
    if (earliest && isAfter(earliest, due)) return false // cycle predates the task
    return true
  }

  const occ = lastScheduledOccurrence(task)
  if (!occ) return false
  // Occurrence is today (or future) -> handled by normal due-today / end_time logic, not "missed".
  if (!isAfter(today, occ)) return false
  // Completed on or after the occurrence day -> done, not missed.
  const lastCompleted = task.last_completed_at ? startOfDay(new Date(task.last_completed_at)) : null
  if (lastCompleted && !isAfter(occ, lastCompleted)) return false
  return true
}

// Deadline datetime for a recurring task's current cycle — the window's due day (or today
// for single-day recurrences), at end_time / due_time / end of day. Used for the countdown.
export function recurringDeadline(task) {
  if (!task.is_recurring || !task.recurrence) return null
  const rec = task.recurrence, now = new Date()
  const datePart = isMonthlyWindow(rec) ? monthlyWindowCycle(rec, now).due : startOfDay(now)
  const [h, m] = (task.end_time || task.due_time || '23:59').split(':').map(Number)
  const d = new Date(datePart); d.setHours(h, m, 0, 0)
  return d
}

// ---- Goals / sub-tasks -------------------------------------------------------
// A "goal" is any task that has at least one sub-task (child pointing to it via parent_id).

export function getSubtasks(task, allTasks) {
  return allTasks.filter(t => t.parent_id === task.id)
}

export function isGoal(task, allTasks) {
  return allTasks.some(t => t.parent_id === task.id)
}

export function isSubtask(task) {
  return !!task.parent_id
}

// { done, total } across a goal's sub-tasks (ignoring cancelled ones).
export function goalProgress(task, allTasks) {
  const subs = getSubtasks(task, allTasks).filter(t => t.status !== 'cancelled')
  const done = subs.filter(t => t.status === 'completed').length
  return { done, total: subs.length }
}

export function isTaskDoneForToday(task) {
  if (!task) return false
  if (task.is_recurring) {
    // Recurring task is "done" if completed today
    return task.last_completed_at ? isToday(new Date(task.last_completed_at)) : false
  }
  return task.status === 'completed'
}

// Is this task something to actually do TODAY? (not done/cancelled; a recurring task is
// only "active" on a scheduled/missed day; a non-recurring one only once its start date
// has arrived). Used so a prerequisite only blocks when it's itself in play today.
export function isActiveToday(task) {
  if (!task) return false
  if (task.status === 'completed' || task.status === 'cancelled') return false
  if (task.is_recurring) return isRecurringTaskDue(task) || isRecurringMissed(task)
  if (task.start_date && isAfter(startOfDay(parseISO(task.start_date)), startOfDay(new Date()))) return false
  return true
}

// A prerequisite only BLOCKS a task when it is active TODAY and not yet done. A prereq
// that isn't scheduled for today (future, or a recurring prereq not due today) does not
// block — so e.g. a daily "Bath" isn't hidden just because "Cut nails" isn't due today.
export function prerequisitesMet(task, allTasks) {
  if (!task.prerequisite_ids || task.prerequisite_ids.length === 0) return true
  return task.prerequisite_ids.every(id => {
    const prereq = allTasks.find(t => t.id === id)
    if (!prereq) return true
    if (isTaskDoneForToday(prereq)) return true   // done -> satisfied
    return !isActiveToday(prereq)                 // not today's -> doesn't block
  })
}

export function isDashboardVisible(task, allTasks) {
  if (task.is_recurring) return (isRecurringTaskDue(task) || isRecurringMissed(task)) && prerequisitesMet(task, allTasks)

  if (task.status === 'completed' || task.status === 'cancelled') return false

  const now = new Date()
  const today = startOfDay(now)

  // Start date must be today or past
  if (task.start_date) {
    const start = startOfDay(parseISO(task.start_date))
    if (isAfter(start, today)) return false
  }

  if (!prerequisitesMet(task, allTasks)) return false

  return true
}

function getCurrentMins() {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

function toMins(timeStr) {
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + m
}

// Task is active right now: start_time passed AND end_time not yet passed
export function isCurrentlyActive(task) {
  const cur = getCurrentMins()
  const started = !task.start_time || cur >= toMins(task.start_time)
  const notEnded = !task.end_time || cur <= toMins(task.end_time)
  return started && notEnded
}

// Task time window has passed, or due_date is in the past
export function isOverdueNow(task) {
  const now = new Date()
  const today = startOfDay(now)
  const cur = getCurrentMins()

  if (task.is_recurring) {
    // Missed on a previous scheduled day and not completed since -> stays overdue.
    if (isRecurringMissed(task)) return true
    // A monthly day-range is overdue only when the due day passes (handled above), not by time-of-day.
    if (isMonthlyWindow(task.recurrence)) return false
    // Otherwise overdue if today's time window has fully passed.
    if (task.start_time && task.end_time) {
      return cur > toMins(task.end_time)
    }
    return false
  }

  // Non-recurring with a due date: overdue once the DEADLINE (due_date + due_time) passes.
  // due_time defaults to end of day, so a due date with no time is overdue only next day.
  if (task.due_date) {
    const due = startOfDay(parseISO(task.due_date))
    if (isAfter(due, today)) return false                 // deadline still in the future
    if (isAfter(today, due)) return true                  // deadline date fully passed
    // Deadline is today -> overdue once the due_time has passed (default end of day).
    if (task.due_time) return cur > toMins(task.due_time)
    return false
  }

  return false
}

// The deadline as a Date (due_date at due_time, default 23:59). Null if no due date.
export function dueDateTime(task) {
  if (!task.due_date) return null
  const d = parseISO(task.due_date)
  const [h, m] = (task.due_time || '23:59').split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d
}

// A task's location ids (multi-location). Falls back to the legacy single location_id.
// Empty array = "anywhere".
export function taskLocationIds(task) {
  if (Array.isArray(task.location_ids) && task.location_ids.length) return task.location_ids
  return task.location_id ? [task.location_id] : []
}

// Presence: does this task belong to where I am right now?
// currentLocationId null/undefined = no location chosen -> everything matches (no filter).
// Otherwise: tasks whose location set INCLUDES it, plus location-less "anywhere" tasks.
export function matchesLocation(task, currentLocationId) {
  if (!currentLocationId) return true
  const locs = taskLocationIds(task)
  return locs.length === 0 || locs.includes(currentLocationId)
}

// Task has an availability window that hasn't opened yet today.
export function windowStartsLaterToday(task) {
  if (!task.start_time) return false
  return getCurrentMins() < toMins(task.start_time)
}

// The window of time in which a task CAN be done (end_time - start_time), in minutes.
// A task with no start/end window is "anytime" → treated as the widest (least constrained).
function windowMins(t) {
  if (!t.start_time || !t.end_time) return Infinity
  const w = toMins(t.end_time) - toMins(t.start_time)
  return w > 0 ? w : Infinity
}

export function sortDashboardTasks(tasks) {
  return [...tasks].sort((a, b) => {
    // 1. Recurring first
    if (a.is_recurring !== b.is_recurring) return a.is_recurring ? -1 : 1

    // 2. Closest deadline first (due_date + due_time) — deadline drives priority
    const aDate = dueDateTime(a)
    const bDate = dueDateTime(b)
    if (aDate && bDate) {
      if (aDate < bDate) return -1
      if (aDate > bDate) return 1
    } else if (aDate) return -1
    else if (bDate) return 1

    // 3. Tighter availability window next (a narrow start–end slot should surface sooner)
    const wa = windowMins(a), wb = windowMins(b)
    if (wa !== wb) return wa - wb

    // 4. Shortest duration first (quick wins) — final tiebreaker
    const durDiff = (a.duration_minutes || 0) - (b.duration_minutes || 0)
    if (durDiff !== 0) return durDiff

    return 0
  })
}

export function formatTime(time) {
  if (!time) return null
  const [h, m] = time.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${m.toString().padStart(2, '0')} ${period}`
}

export function formatDuration(minutes) {
  if (!minutes) return null
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function ordinal(n) {
  const s = ['th','st','nd','rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

export function getRecurrenceLabel(recurrence) {
  if (!recurrence) return 'Recurring'
  switch (recurrence.frequency) {
    case 'daily': return 'Daily'
    case 'alternate': return 'Every other day'
    case 'weekly': return `Weekly · ${(recurrence.days || []).map(d => DAYS[d]).join(', ')}`
    case 'monthly': return isMonthlyWindow(recurrence)
      ? `Monthly · ${ordinal(recurrence.start_day)}–${ordinal(recurrence.due_day)}`
      : `Monthly · ${ordinal(recurrence.day)}`
    case 'yearly': return `Yearly · ${MONTHS[(recurrence.month || 1) - 1]} ${recurrence.day}`
    default: return 'Recurring'
  }
}
