import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { format } from 'date-fns'

export default function Reconciliation() {
  const [links,   setLinks]   = useState([])
  const [loading, setLoading] = useState(true)
  const [detail,  setDetail]  = useState(null) // { link, linesA, linesB }

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data: rawLinks } = await supabase
      .from('inter_ledger_links')
      .select(`id,
        account_a:account_a_id(id, name, book_id, books(name)),
        account_b:account_b_id(id, name, book_id, books(name))`)

    const resolved = await Promise.all((rawLinks || []).map(async link => {
      const [{ data: linesA }, { data: linesB }] = await Promise.all([
        supabase.from('journal_lines')
          .select('id, debit, credit, journal_entries(id, date, narration, reference_no)')
          .eq('account_id', link.account_a.id)
          .order('journal_entries(date)', { ascending: true }),
        supabase.from('journal_lines')
          .select('id, debit, credit, journal_entries(id, date, narration, reference_no)')
          .eq('account_id', link.account_b.id)
          .order('journal_entries(date)', { ascending: true }),
      ])
      const balA = (linesA || []).reduce((s, l) => s + l.debit - l.credit, 0)
      const balB = (linesB || []).reduce((s, l) => s + l.debit - l.credit, 0)
      const diff  = Math.abs(balA + balB)
      return { ...link, balA, balB, diff, matched: diff < 0.01, linesA: linesA || [], linesB: linesB || [] }
    }))

    setLinks(resolved)
    setLoading(false)
  }

  const fmt = n => `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Reconciliation</h1>
        <Link to="/accounts" className="btn-secondary text-sm">Manage Links</Link>
      </div>

      {links.length === 0 && (
        <div className="card p-8 text-center text-gray-400">
          <p className="text-lg">No reconciliation links set up yet.</p>
          <p className="text-sm mt-1">Go to <Link to="/accounts" className="text-brand-600 underline">Chart of Accounts</Link> to link mirror accounts across books.</p>
        </div>
      )}

      {links.map(link => (
        <div key={link.id} className={`card overflow-hidden border-l-4 ${link.matched ? 'border-l-green-400' : 'border-l-red-400'}`}>
          <div className="px-5 py-4 flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                {link.matched
                  ? <span className="text-green-600 font-bold text-lg">✓</span>
                  : <span className="text-red-500 font-bold text-lg">✗</span>}
                <span className="font-semibold">
                  {link.account_a.books.name} › {link.account_a.name}
                  <span className="text-gray-400 mx-2">↔</span>
                  {link.account_b.books.name} › {link.account_b.name}
                </span>
              </div>
              {!link.matched && (
                <p className="text-red-600 text-sm mt-1 ml-7">
                  Difference of <strong>{fmt(link.diff)}</strong> — accounts are out of sync
                </p>
              )}
            </div>
            <div className="flex gap-6 text-sm">
              <div className="text-center">
                <p className="text-xs text-gray-400">{link.account_a.books.name}</p>
                <p className="font-bold">{fmt(link.balA)} {link.balA >= 0 ? 'Dr' : 'Cr'}</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-gray-400">{link.account_b.books.name}</p>
                <p className="font-bold">{fmt(link.balB)} {link.balB >= 0 ? 'Dr' : 'Cr'}</p>
              </div>
            </div>
            <button
              onClick={() => setDetail(detail?.link.id === link.id ? null : link)}
              className="btn-secondary text-xs py-1">
              {detail?.id === link.id ? 'Hide' : 'View entries'}
            </button>
          </div>

          {detail?.id === link.id && (
            <div className="border-t border-gray-100 grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
              {[
                { label: `${link.account_a.books.name} › ${link.account_a.name}`, lines: link.linesA },
                { label: `${link.account_b.books.name} › ${link.account_b.name}`, lines: link.linesB },
              ].map(side => (
                <div key={side.label}>
                  <p className="px-4 py-2 text-xs font-semibold text-gray-500 bg-gray-50">{side.label}</p>
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className="table-head">Date</th>
                        <th className="table-head">Narration</th>
                        <th className="table-head text-right">Dr</th>
                        <th className="table-head text-right">Cr</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {side.lines.length === 0 && (
                        <tr><td colSpan={4} className="table-cell text-center text-gray-300 py-4">No entries</td></tr>
                      )}
                      {side.lines.map(l => (
                        <tr key={l.id} className="hover:bg-gray-50">
                          <td className="table-cell text-xs whitespace-nowrap">
                            {l.journal_entries?.date ? format(new Date(l.journal_entries.date), 'dd MMM yy') : ''}
                          </td>
                          <td className="table-cell text-xs truncate max-w-[160px]">{l.journal_entries?.narration}</td>
                          <td className="table-cell text-right text-xs">{l.debit  > 0 ? fmt(l.debit)  : ''}</td>
                          <td className="table-cell text-right text-xs">{l.credit > 0 ? fmt(l.credit) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
