import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import NewEntry from '../pages/NewEntry'

// App-wide "floating" entry form. Any page can open it to create or edit a
// journal entry without navigating away, and get a callback when it's saved
// (so the page can refresh itself in place).

const Ctx = createContext(null)
export const useEntryModal = () => useContext(Ctx)

// Pages call this to auto-refresh their data whenever ANY entry is saved via
// the modal or the floating + button.
export function useEntryRefresh(fn) {
  const { setPageRefresh } = useEntryModal()
  useEffect(() => {
    setPageRefresh(() => fn)
    return () => setPageRefresh(null)
  }, [fn, setPageRefresh])
}

export function EntryModalProvider({ children }) {
  const [state, setState] = useState(null) // { entryId, initial, onSaved } | null
  const refreshRef = useRef(null)

  const open  = useCallback((opts = {}) => setState({ entryId: opts.entryId ?? null, initial: opts.initial ?? null, onSaved: opts.onSaved }), [])
  const close = useCallback(() => setState(null), [])
  const setPageRefresh = useCallback(fn => { refreshRef.current = fn }, [])

  function handleDone(saved, createdIds) {
    if (saved) {
      if (state?.onSaved) state.onSaved(createdIds)
      if (refreshRef.current) refreshRef.current()   // refresh the current page in place
    }
    setState(null)
  }

  return (
    <Ctx.Provider value={{ open, close, setPageRefresh }}>
      {children}

      {/* Floating "New Entry" action button — available on every page */}
      <button
        onClick={() => open()}
        title="New entry"
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full bg-brand-600 text-white text-2xl shadow-lg hover:bg-brand-700 flex items-center justify-center"
      >+</button>

      {state && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-2 sm:p-4 overflow-y-auto"
          onMouseDown={e => { if (e.target === e.currentTarget) close() }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl my-4 sm:my-8 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 sticky top-0 bg-white z-10">
              <h2 className="font-semibold">{state.entryId ? 'Edit Entry' : state.initial ? 'Review Draft Entry' : 'New Journal Entry'}</h2>
              <button onClick={close} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
            </div>
            <div className="p-4">
              <NewEntry entryId={state.entryId} initial={state.initial} embedded onDone={handleDone} />
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}
