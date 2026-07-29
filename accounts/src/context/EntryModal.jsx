import React, { createContext, useContext, useState, useCallback } from 'react'
import NewEntry from '../pages/NewEntry'

// App-wide "floating" entry form. Any page can open it to create or edit a
// journal entry without navigating away, and get a callback when it's saved
// (so the page can refresh itself in place).

const Ctx = createContext(null)
export const useEntryModal = () => useContext(Ctx)

export function EntryModalProvider({ children }) {
  const [state, setState] = useState(null) // { entryId, onSaved } | null

  const open  = useCallback((opts = {}) => setState({ entryId: opts.entryId ?? null, onSaved: opts.onSaved }), [])
  const close = useCallback(() => setState(null), [])

  function handleDone(saved) {
    if (saved && state?.onSaved) state.onSaved()
    setState(null)
  }

  return (
    <Ctx.Provider value={{ open, close }}>
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
              <h2 className="font-semibold">{state.entryId ? 'Edit Entry' : 'New Journal Entry'}</h2>
              <button onClick={close} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
            </div>
            <div className="p-4">
              <NewEntry entryId={state.entryId} embedded onDone={handleDone} />
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}
