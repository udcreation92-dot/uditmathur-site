import React, { useState } from 'react'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'

export default function Login() {
  const [email,    setEmail]    = useState('udcreation92@gmail.com')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) toast.error(error.message)
    setLoading(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-900 to-brand-700 p-4">
      <div className="card w-full max-w-sm p-8">
        <h1 className="text-2xl font-bold text-brand-700 mb-1">Accounts</h1>
        <p className="text-sm text-gray-500 mb-6">Sign in to your accounting workspace</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoFocus />
          </div>
          <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
