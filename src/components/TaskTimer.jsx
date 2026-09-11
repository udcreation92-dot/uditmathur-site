import { useState, useEffect } from 'react'

// Format seconds as H:MM:SS or M:SS
function fmt(totalSec) {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

// Live time-tracking control for a task.
//  - baseSeconds: already-accumulated tracked time for this task TODAY (closed intervals)
//  - runningSince: ISO string when the current open interval started, or null if not running
//  - onStart / onPause: handlers (starting auto-pauses any other running task, server-side)
export default function TaskTimer({ baseSeconds = 0, runningSince = null, onStart, onPause }) {
  const [now, setNow] = useState(Date.now())
  const running = !!runningSince

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const liveSec = running ? (now - new Date(runningSince).getTime()) / 1000 : 0
  const total = baseSeconds + liveSec
  const showTotal = running || baseSeconds > 0

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={running ? onPause : onStart}
        title={running ? 'Pause timer' : 'Start timer'}
        className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors ${
          running
            ? 'bg-red-500 text-white border-red-500 hover:bg-red-600'
            : 'bg-white text-slate-600 border-slate-200 hover:border-blue-400 hover:text-blue-600'
        }`}
      >
        {running ? (
          <>
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            Pause
          </>
        ) : (
          <>
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            {baseSeconds > 0 ? 'Resume' : 'Start'}
          </>
        )}
      </button>
      {showTotal && (
        <span className={`text-xs font-bold tabular-nums ${running ? 'text-red-600' : 'text-slate-500'}`}>
          {running && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1 animate-pulse align-middle" />}
          {fmt(total)}
        </span>
      )}
    </div>
  )
}
