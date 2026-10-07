import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { monthOf, monthStart, monthEnd, today } from './dates'

const SAVE_DELAY = 700

// Loads a client's data month-by-month and autosaves edits as debounced section patches.
export function useClientData(code, clientId) {
  const [client, setClient] = useState(null)
  const [days, setDays] = useState({})
  const [plans, setPlans] = useState({})
  const [months, setMonths] = useState({})
  const [status, setStatus] = useState('idle') // idle | loading | saving | saved | error
  const [error, setError] = useState(null)

  const loaded = useRef(new Set())
  const pendingDays = useRef({})   // { date: { section: value } }
  const pendingMonths = useRef({}) // { month: { key: value } }
  const timer = useRef(null)
  const inflight = useRef(0)

  const ensureMonth = useCallback(async (m) => {
    if (loaded.current.has(m)) return
    loaded.current.add(m)
    try {
      setStatus((s) => (s === 'idle' ? 'loading' : s))
      const r = await api.load(code, clientId, monthStart(m), monthEnd(m))
      setClient(r.client)
      setDays((p) => ({ ...r.days, ...p }))
      setPlans((p) => ({ ...p, ...r.plans }))
      setMonths((p) => ({ ...r.months, ...p }))
      setStatus((s) => (s === 'loading' ? 'idle' : s))
    } catch (e) {
      loaded.current.delete(m)
      setError(e.message); setStatus('error')
    }
  }, [code, clientId])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const d = pendingDays.current; pendingDays.current = {}
    const mo = pendingMonths.current; pendingMonths.current = {}
    const jobs = [
      ...Object.entries(d).map(([day, patch]) => api.saveDay(code, clientId, day, patch)),
      ...Object.entries(mo).map(([m, patch]) => api.saveMonth(code, clientId, m, patch)),
    ]
    if (!jobs.length) return
    inflight.current += 1
    setStatus('saving')
    try {
      await Promise.all(jobs)
      inflight.current -= 1
      if (!inflight.current) { setStatus('saved'); setError(null) }
    } catch (e) {
      inflight.current -= 1
      // put the failed patches back so the next edit (or retry) resends them
      for (const [day, patch] of Object.entries(d)) pendingDays.current[day] = { ...patch, ...pendingDays.current[day] }
      for (const [m, patch] of Object.entries(mo)) pendingMonths.current[m] = { ...patch, ...pendingMonths.current[m] }
      setError(e.message); setStatus('error')
    }
  }, [code, clientId])

  const schedule = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY)
  }, [flush])

  // Replace one top-level section of a day's data (meals, macros, habits, sleep, training)
  const setDaySection = useCallback((date, section, value) => {
    setDays((p) => ({ ...p, [date]: { ...(p[date] || {}), [section]: value } }))
    pendingDays.current[date] = { ...(pendingDays.current[date] || {}), [section]: value }
    schedule()
  }, [schedule])

  const setMonthKey = useCallback((month, k, value) => {
    setMonths((p) => ({ ...p, [month]: { ...(p[month] || {}), [k]: value } }))
    pendingMonths.current[month] = { ...(pendingMonths.current[month] || {}), [k]: value }
    schedule()
  }, [schedule])

  // Trainer only. plansByDate = { 'YYYY-MM-DD': { '1': '…', … } }
  const savePlans = useCallback(async (plansByDate) => {
    setStatus('saving')
    try {
      await api.savePlans(code, clientId, plansByDate)
      setPlans((p) => ({ ...p, ...plansByDate }))
      setStatus('saved'); setError(null)
    } catch (e) {
      setError(e.message); setStatus('error'); throw e
    }
  }, [code, clientId])

  // Fetch a range without caching into the month set (used for "copy previous week")
  const fetchPlans = useCallback(async (from, to) => (await api.load(code, clientId, from, to)).plans, [code, clientId])

  // Save immediately when the tab is hidden / closed
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  useEffect(() => { ensureMonth(monthOf(today())) }, [ensureMonth])

  return {
    client, setClient, days, plans, months, status, error,
    ensureMonth, setDaySection, setMonthKey, savePlans, fetchPlans, retry: flush,
  }
}
