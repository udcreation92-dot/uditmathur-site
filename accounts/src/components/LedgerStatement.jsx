import React from 'react'
import { inr, ddmmyyyy } from '../lib/gst'

// A4 print-friendly "Statement of Account" for handing to an outside party.
// Props:
//  - firm:   firm_profiles row (optional) — letterhead
//  - bookName, accountName, accountType
//  - from, to (ISO) — statement period (optional)
//  - opening: opening balance (signed dr-positive)
//  - rows: [{ date, narration, ref, particulars, dr, cr, balance }]  (chronological)
//  - closing: closing balance (signed)
//  - totalDr, totalCr
export default function LedgerStatement({
  firm = {}, bookName = '', accountName = '', accountType = '',
  from, to, opening = 0, rows = [], closing = 0, totalDr = 0, totalCr = 0,
}) {
  const drcr = n => `${inr(Math.abs(n))} ${n >= 0 ? 'Dr' : 'Cr'}`
  const th = { padding: '6px 8px', textAlign: 'left', fontWeight: 700, borderBottom: '1.5px solid #333', fontSize: '11px' }
  const td = { padding: '5px 8px', fontSize: '11px', borderBottom: '1px solid #e5e5e5', verticalAlign: 'top' }
  const tdR = { ...td, textAlign: 'right', fontFamily: '"Courier New", monospace', whiteSpace: 'nowrap' }

  return (
    <div style={{ width: '210mm', minHeight: '297mm', boxSizing: 'border-box', padding: '18mm 16mm',
      fontFamily: 'Helvetica, Arial, sans-serif', color: '#1a1a1a', background: '#fff' }}>

      {/* Letterhead */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #1a1a1a', paddingBottom: '10px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {firm.logo_url && <img src={firm.logo_url} alt="" style={{ width: '52px', height: '52px', objectFit: 'contain' }} />}
          <div>
            <div style={{ fontSize: '18px', fontWeight: 700, textTransform: 'uppercase' }}>{firm.firm_name || bookName}</div>
            {firm.tagline && <div style={{ fontSize: '10px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{firm.tagline}</div>}
            <div style={{ fontSize: '10px', color: '#555', marginTop: '3px', lineHeight: 1.5 }}>
              {firm.address && <>{firm.address}<br /></>}
              {firm.gstin && <>GSTIN: {firm.gstin}&nbsp;&nbsp;</>}{firm.pan && <>PAN: {firm.pan}</>}
              {(firm.email || firm.mobile) && <><br />{firm.email || ''}&nbsp;&nbsp;{firm.mobile || ''}</>}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>Statement of Account</div>
          <div style={{ fontSize: '10px', color: '#555', marginTop: '4px' }}>
            {(from || to) ? `Period: ${from ? ddmmyyyy(from) : '—'} to ${to ? ddmmyyyy(to) : '—'}` : 'All dates'}<br />
            Generated: {ddmmyyyy(new Date())}
          </div>
        </div>
      </div>

      {/* Account line */}
      <div style={{ margin: '12px 0', fontSize: '12px' }}>
        <span style={{ color: '#555' }}>Account: </span>
        <span style={{ fontWeight: 700, fontSize: '14px' }}>{accountName || 'All accounts'}</span>
        {accountType && <span style={{ color: '#888', fontSize: '11px' }}> · {accountType}</span>}
      </div>

      {/* Transactions */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...th, width: '74px' }}>Date</th>
            <th style={th}>Particulars</th>
            <th style={{ ...th, width: '80px' }}>Ref</th>
            <th style={{ ...th, textAlign: 'right', width: '90px' }}>Debit</th>
            <th style={{ ...th, textAlign: 'right', width: '90px' }}>Credit</th>
            <th style={{ ...th, textAlign: 'right', width: '104px' }}>Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={td} colSpan={5}><em>Opening balance</em></td>
            <td style={{ ...tdR, fontWeight: 700 }}>{drcr(opening)}</td>
          </tr>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{ddmmyyyy(r.date)}</td>
              <td style={td}>
                <div>{r.particulars}</div>
                {r.narration && <div style={{ color: '#888', fontSize: '10px' }}>{r.narration}</div>}
              </td>
              <td style={{ ...td, fontSize: '10px', color: '#888' }}>{r.ref || ''}</td>
              <td style={tdR}>{r.dr ? inr(r.dr) : ''}</td>
              <td style={tdR}>{r.cr ? inr(r.cr) : ''}</td>
              <td style={tdR}>{drcr(r.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...td, borderTop: '1.5px solid #333', fontWeight: 700 }} colSpan={3}>Totals</td>
            <td style={{ ...tdR, borderTop: '1.5px solid #333', fontWeight: 700 }}>{inr(totalDr)}</td>
            <td style={{ ...tdR, borderTop: '1.5px solid #333', fontWeight: 700 }}>{inr(totalCr)}</td>
            <td style={{ ...tdR, borderTop: '1.5px solid #333' }}></td>
          </tr>
          <tr>
            <td style={{ ...td, borderBottom: 'none', fontWeight: 700 }} colSpan={5}>Closing balance</td>
            <td style={{ ...tdR, borderBottom: 'none', fontWeight: 700, fontSize: '13px' }}>{drcr(closing)}</td>
          </tr>
        </tfoot>
      </table>

      <div style={{ marginTop: '10px', fontSize: '10px', color: '#666', fontStyle: 'italic' }}>
        "Dr" = amount receivable from / debit balance; "Cr" = amount payable to / credit balance.
      </div>
      <div style={{ marginTop: '28px', fontSize: '9px', color: '#999', borderTop: '1px solid #ddd', paddingTop: '6px', textAlign: 'center' }}>
        This is a computer-generated statement and does not require a signature. E. &amp; O.E.
      </div>
    </div>
  )
}
