import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import Dashboard from './components/Dashboard'
import AllTasks from './components/AllTasks'
import TaskForm from './components/TaskForm'
import Header from './components/Header'
import LocationManager from './components/LocationManager'
import LoginPage from './components/LoginPage'

export default function App() {
  const [view, setView] = useState('dashboard')
  const [tasks, setTasks] = useState([])
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [editTask, setEditTask] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [configError, setConfigError] = useState(false)
  const [session, setSession] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    if (!import.meta.env.VITE_SUPABASE_URL) {
      setConfigError(true)
      setLoading(false)
      setAuthChecked(true)
      return
    }

    // Safety timeout — if auth check hangs for >5s, unblock the UI
    const timeout = setTimeout(() => {
      setAuthChecked(true)
      setLoading(false)
    }, 5000)

    // Check existing session on load
    supabase.auth.getSession().then(({ data: { session } }) => {
      clearTimeout(timeout)
      setSession(session)
      setAuthChecked(true)
      if (session) { fetchTasks(); fetchLocations() }
      else setLoading(false)
    }).catch(() => {
      clearTimeout(timeout)
      setAuthChecked(true)
      setLoading(false)
    })

    // Listen for login/logout
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) { fetchTasks(); fetchLocations() }
      else { setTasks([]); setLocations([]) }
    })

    const channel = supabase
      .channel('tasks-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, fetchTasks)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'locations' }, fetchLocations)
      .subscribe()

    return () => { subscription.unsubscribe(); supabase.removeChannel(channel) }
  }, [])

  async function fetchTasks() {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: false })
    if (!error) setTasks(data || [])
    setLoading(false)
  }

  async function fetchLocations() {
    const { data } = await supabase
      .from('locations')
      .select('*')
      .order('name', { ascending: true })
    if (data) setLocations(data)
  }

  function openAdd() { setEditTask(null); setShowForm(true) }
  function openEdit(task) { setEditTask(task); setShowForm(true) }
  function closeForm() { setShowForm(false); setEditTask(null) }

  async function completeTask(task) {
    if (task.is_recurring) {
      await supabase.from('tasks').update({ last_completed_at: new Date().toISOString() }).eq('id', task.id)
    } else {
      await supabase.from('tasks').update({ status: 'completed' }).eq('id', task.id)
    }
    fetchTasks()
  }

  async function deleteTask(id) {
    if (!window.confirm('Delete this task?')) return
    await supabase.from('tasks').delete().eq('id', id)
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  const cardProps = { tasks, locations, onEdit: openEdit, onComplete: completeTask, onDelete: deleteTask }

  // Show spinner while auth is being checked
  if (!authChecked) return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <svg className="animate-spin w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"/>
      </svg>
    </div>
  )

  // Show login page if not signed in
  if (!session) return <LoginPage />

  if (configError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center">
          <div className="text-5xl mb-4">⚙️</div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">Setup Required</h2>
          <p className="text-slate-600 text-sm mb-4">
            Create a <code className="bg-slate-100 px-1 py-0.5 rounded">.env.local</code> file in the project root with your Supabase credentials.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header view={view} onViewChange={setView} onAdd={openAdd} onSignOut={signOut} />

      <main className="max-w-2xl mx-auto px-4 py-6 pb-24 md:pb-6">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <svg className="animate-spin w-6 h-6 mr-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"/>
            </svg>
            Loading…
          </div>
        ) : view === 'dashboard' ? (
          <Dashboard {...cardProps} />
        ) : view === 'all' ? (
          <AllTasks {...cardProps} />
        ) : (
          <LocationManager locations={locations} onUpdate={fetchLocations} />
        )}
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex md:hidden z-10">
        <MobileNavBtn active={view === 'dashboard'} onClick={() => setView('dashboard')}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          Dashboard
        </MobileNavBtn>
        <button
          onClick={openAdd}
          className="flex-1 flex flex-col items-center justify-center py-2 gap-0.5 bg-blue-600 text-white text-xs font-semibold"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Add
        </button>
        <MobileNavBtn active={view === 'all'} onClick={() => setView('all')}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          All Tasks
        </MobileNavBtn>
        <MobileNavBtn active={view === 'locations'} onClick={() => setView('locations')}>
          <span className="text-lg leading-none">📍</span>
          Locations
        </MobileNavBtn>
      </nav>

      {showForm && (
        <TaskForm task={editTask} tasks={tasks} locations={locations} onClose={closeForm} onSave={fetchTasks} />
      )}
    </div>
  )
}

function MobileNavBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-xs font-medium transition-colors ${
        active ? 'text-blue-600' : 'text-slate-400'
      }`}
    >
      {children}
    </button>
  )
}
