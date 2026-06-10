export default function Header({ view, onViewChange, onAdd, onSignOut }) {
  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
      <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-800">Tasks</h1>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1">
          <NavBtn active={view === 'dashboard'} onClick={() => onViewChange('dashboard')}>Dashboard</NavBtn>
          <NavBtn active={view === 'all'} onClick={() => onViewChange('all')}>All Tasks</NavBtn>
          <NavBtn active={view === 'locations'} onClick={() => onViewChange('locations')}>📍 Locations</NavBtn>
          <button
            onClick={onAdd}
            className="ml-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
          >
            + Add Task
          </button>
          <button
            onClick={onSignOut}
            className="ml-1 text-slate-400 hover:text-slate-700 text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            title="Sign out"
          >
            Sign Out
          </button>
        </nav>

        {/* Mobile: just show current view name */}
        <span className="md:hidden text-sm text-slate-500">
          {view === 'dashboard' ? 'Today\'s Tasks' : 'All Tasks'}
        </span>
      </div>
    </header>
  )
}

function NavBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${
        active
          ? 'bg-blue-50 text-blue-700'
          : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  )
}
