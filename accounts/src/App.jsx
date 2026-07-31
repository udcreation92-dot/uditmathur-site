import React, { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { supabase } from './lib/supabase'
import Layout from './components/Layout'
import { EntryModalProvider } from './context/EntryModal'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Books from './pages/Books'
import ChartOfAccounts from './pages/ChartOfAccounts'
import NewEntry from './pages/NewEntry'
import Ledger from './pages/Ledger'
import TrialBalance from './pages/TrialBalance'
import BulkImport from './pages/BulkImport'
import Reconciliation from './pages/Reconciliation'
import StatementReconcile from './pages/StatementReconcile'
import Reports from './pages/Reports'
import AverageBalance from './pages/AverageBalance'
import Commitments from './pages/Commitments'
import FundOptimizer from './pages/FundOptimizer'
import FirmProfile from './pages/FirmProfile'
import Clients from './pages/Clients'
import WorkOrders from './pages/WorkOrders'
import Invoices from './pages/Invoices'
import InvoiceBuilder from './pages/InvoiceBuilder'
import InvoicePrintPage from './pages/InvoicePrintPage'
import GstSummary from './pages/GstSummary'

function ProtectedRoute({ session, children }) {
  if (!session) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <>
      <Toaster position="top-right" />
      <Routes>
        <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
        {/* Full-page invoice print/view — outside the app chrome so it prints clean */}
        <Route path="/invoices/:id/print" element={
          <ProtectedRoute session={session}><InvoicePrintPage /></ProtectedRoute>
        } />
        <Route path="/" element={
          <ProtectedRoute session={session}>
            <EntryModalProvider>
              <Layout session={session} />
            </EntryModalProvider>
          </ProtectedRoute>
        }>
          <Route index element={<Dashboard />} />
          <Route path="books" element={<Books />} />
          <Route path="accounts" element={<ChartOfAccounts />} />
          <Route path="entry/new" element={<NewEntry />} />
          <Route path="entry/:id/edit" element={<NewEntry />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="trial-balance" element={<TrialBalance />} />
          <Route path="import" element={<BulkImport />} />
          <Route path="reconciliation" element={<Reconciliation />} />
          <Route path="statement-reconcile" element={<StatementReconcile />} />
          <Route path="reports" element={<Reports />} />
          <Route path="avg-balance" element={<AverageBalance />} />
          <Route path="commitments" element={<Commitments />} />
          <Route path="fund-optimizer" element={<FundOptimizer />} />
          <Route path="firm-profile" element={<FirmProfile />} />
          <Route path="clients" element={<Clients />} />
          <Route path="work-orders" element={<WorkOrders />} />
          <Route path="invoices" element={<Invoices />} />
          <Route path="invoices/new" element={<InvoiceBuilder />} />
          <Route path="invoices/:id/edit" element={<InvoiceBuilder />} />
          <Route path="gst" element={<GstSummary />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
