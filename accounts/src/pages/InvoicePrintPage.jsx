import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import InvoicePrint from '../components/InvoicePrint'

export default function InvoicePrintPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    (async () => {
      const { data: inv } = await supabase.from('invoices')
        .select('*, invoice_items(*), work_orders(wo_number, project_site, wo_date, po_no)')
        .eq('id', id).single()
      if (!inv) { setNotFound(true); return }

      let firm = inv.firm_snapshot
      let client = inv.client_snapshot
      // Proforma has no snapshot yet — resolve live
      if (!firm) {
        const { data: fp } = await supabase.from('firm_profiles').select('*').eq('book_id', inv.book_id).maybeSingle()
        firm = fp || {}
      }
      if (!client) {
        const { data: cl } = await supabase.from('clients').select('*').eq('id', inv.client_id).maybeSingle()
        client = cl || {}
      }
      setData({ inv, firm, client })
    })()
  }, [id])

  useEffect(() => {
    document.body.classList.add('printing-invoice')
    return () => document.body.classList.remove('printing-invoice')
  }, [])

  if (notFound) return <div className="p-8">Invoice not found. <button className="text-brand-600 underline" onClick={() => navigate('/invoices')}>Back</button></div>
  if (!data) return <div className="flex items-center justify-center h-screen"><div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" /></div>

  const { inv, firm, client } = data
  const items = (inv.invoice_items || []).sort((a, b) => a.seq - b.seq)
  const wo = inv.work_orders || null

  return (
    <div style={{ background: 'oklch(94% 0.005 235)', minHeight: '100vh' }}>
      {/* Toolbar — hidden on print */}
      <div className="no-print sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shadow-sm">
        <button onClick={() => navigate('/invoices')} className="btn-secondary text-sm">← Back</button>
        <button onClick={() => window.print()} className="btn-primary text-sm">🖨 Print / Save as PDF</button>
        {inv.status === 'proforma' && (
          <button onClick={() => navigate(`/invoices/${inv.id}/edit`)} className="btn-secondary text-sm">Edit proforma</button>
        )}
        <span className="text-xs text-gray-500 ml-auto">
          {inv.status === 'proforma' ? 'PROFORMA — not recorded in books' : `Tax Invoice ${inv.invoice_no || ''}`}
        </span>
      </div>

      <div className="flex justify-center py-6">
        <InvoicePrint firm={firm} client={client} invoice={inv} workOrder={wo} items={items} />
      </div>
    </div>
  )
}
