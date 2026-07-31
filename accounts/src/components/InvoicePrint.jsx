import React from 'react'
import { inr, ddmmyyyy } from '../lib/gst'

// Design tokens from the blueprint handoff
const ACCENT   = 'oklch(30% 0.07 235)'
const INK      = 'oklch(18% 0.01 250)'
const HAIR     = 'oklch(78% 0.01 250)'
const HAIR2    = 'oklch(85% 0.005 250)'
const LABEL    = 'oklch(50% 0.01 250)'
const PAGE_BG  = 'oklch(98.5% 0.004 235)'
const mono = { fontFamily: '"Courier New", ui-monospace, monospace' }

const sectionLabel = {
  fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.8px', color: ACCENT, marginBottom: '5px',
}

/**
 * Renders one A4 invoice page in the blueprint style.
 * Props:
 *  - firm:   { firm_name, tagline, logo_url, address, gstin, state_code, email, mobile,
 *              bank_account_name, bank_account_number, bank_ifsc, terms }
 *  - client: { name, address, gstin, state_code }
 *  - invoice:{ status, invoice_no, proforma_no, invoice_date, due_date, place_of_supply,
 *              is_interstate, taxable_total, cgst_total, sgst_total, igst_total,
 *              grand_total, amount_in_words }
 *  - workOrder: { wo_number, project_site, wo_date, po_no } | null
 *  - items:  [{ description, hsn_sac, taxable_value, cgst_rate, cgst_amt, sgst_rate, sgst_amt, igst_rate, igst_amt, line_total }]
 */
export default function InvoicePrint({ firm = {}, client = {}, invoice = {}, workOrder = null, items = [] }) {
  const interstate = !!invoice.is_interstate
  const isProforma = invoice.status === 'proforma'
  const title = isProforma ? 'Proforma Invoice' : 'Tax Invoice'
  const docNo = isProforma ? (invoice.proforma_no || '—') : (invoice.invoice_no || '—')

  const cell = { padding: '8px 6px' }
  const cellR = { ...cell, ...mono, textAlign: 'right' }

  return (
    <section className="invoice-page blueprint-grid" style={{
      fontFamily: 'Helvetica, Arial, sans-serif', color: INK, padding: '34px 40px',
      boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '16px',
      backgroundColor: PAGE_BG, position: 'relative', width: '210mm', minHeight: '297mm',
    }}>
      <CornerTicks />

      {/* Header / title block */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: '16px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flex: 1 }}>
          <div style={{
            width: '60px', height: '60px', border: '1.5px dashed oklch(55% 0.01 250)', borderRadius: '4px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            ...mono, fontSize: '9px', color: 'oklch(55% 0.01 250)', flexShrink: 0,
          }}>
            {firm.logo_url ? <img src={firm.logo_url} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : 'LOGO'}
          </div>
          <div>
            <div style={{ fontSize: '19px', fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase' }}>
              {firm.firm_name || '[Your Company Name]'}
            </div>
            {firm.tagline && (
              <div style={{ fontSize: '11px', letterSpacing: '0.6px', textTransform: 'uppercase', color: ACCENT, fontWeight: 700, marginTop: '1px' }}>
                {firm.tagline}
              </div>
            )}
            <div style={{ ...mono, fontSize: '11.5px', lineHeight: 1.65, color: 'oklch(40% 0.01 250)', marginTop: '4px' }}>
              {firm.address && <>{firm.address}<br /></>}
              {firm.gstin && <>GSTIN: {firm.gstin}&nbsp;&nbsp;STATE: {firm.state_code || ''}<br /></>}
              {firm.pan && <>PAN: {firm.pan}<br /></>}
              {(firm.email || firm.mobile) && <>{firm.email || ''}&nbsp;&nbsp;{firm.mobile || ''}</>}
            </div>
          </div>
        </div>

        <div style={{ border: `1.5px solid ${ACCENT}`, width: '230px', flexShrink: 0, height: 'fit-content' }}>
          <div style={{ background: ACCENT, color: 'oklch(98% 0.005 250)', textAlign: 'center', fontSize: '14px', fontWeight: 700, letterSpacing: '2px', padding: '5px 0', textTransform: 'uppercase' }}>
            {title}
          </div>
          <table style={{ ...mono, width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
            <tbody>
              <TitleRow label={isProforma ? 'PROFORMA NO' : 'INVOICE NO'} value={docNo} bold />
              <TitleRow label="DATE" value={ddmmyyyy(invoice.invoice_date)} />
              <TitleRow label="DUE DATE" value={invoice.due_date ? ddmmyyyy(invoice.due_date) : '—'} />
              <TitleRow label="SUPPLY" value={invoice.place_of_supply || '—'} />
            </tbody>
          </table>
        </div>
      </div>

      {/* Bill To / Work Order */}
      <div style={{ display: 'flex', border: `1px solid ${HAIR}` }}>
        <div style={{ flex: 1, padding: '10px 14px', borderRight: workOrder ? `1px solid ${HAIR}` : 'none' }}>
          <div style={sectionLabel}>Bill To</div>
          <div style={{ fontSize: '13.5px', fontWeight: 700 }}>{client.name || '[Client Name]'}</div>
          <div style={{ ...mono, fontSize: '11.5px', lineHeight: 1.7, color: 'oklch(35% 0.01 250)', marginTop: '3px' }}>
            {client.address && <>{client.address}<br /></>}
            {client.gstin && <>GSTIN: {client.gstin}<br /></>}
            {client.state_code && <>STATE: {client.state_code}</>}
          </div>
        </div>
        {workOrder && (
          <div style={{ flex: 1, padding: '10px 14px', background: 'oklch(96% 0.006 235)' }}>
            <div style={sectionLabel}>Work Order Details</div>
            <div style={{ ...mono, fontSize: '11.5px', lineHeight: 1.9, color: 'oklch(32% 0.01 250)' }}>
              WORK ORDER NO: {workOrder.wo_number || '—'}<br />
              PROJECT/SITE: {workOrder.project_site || '—'}<br />
              WO DATE: {workOrder.wo_date ? ddmmyyyy(workOrder.wo_date) : '—'}&nbsp; PO NO: {workOrder.po_no || '—'}
            </div>
          </div>
        )}
      </div>

      {/* Line items */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px', border: `1px solid ${ACCENT}` }}>
        <thead>
          <tr style={{ background: ACCENT, color: 'oklch(98% 0.005 250)' }}>
            <Th w="24px">#</Th>
            <Th>Description of Work</Th>
            <Th mono w="56px">HSN/SAC</Th>
            <Th mono r w="76px">Taxable Value</Th>
            {interstate ? <>
              <Th mono r w="40px">IGST %</Th>
              <Th mono r w="76px">IGST Amt</Th>
            </> : <>
              <Th mono r w="36px">CGST %</Th>
              <Th mono r w="58px">CGST Amt</Th>
              <Th mono r w="36px">SGST %</Th>
              <Th mono r w="58px">SGST Amt</Th>
            </>}
            <Th mono r w="76px">Total</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i} style={{ borderTop: `1px solid ${HAIR2}`, background: i % 2 ? 'oklch(97% 0.004 235)' : 'transparent' }}>
              <td style={cell}>{i + 1}</td>
              <td style={cell}>{it.description}</td>
              <td style={{ ...cell, ...mono }}>{it.hsn_sac || ''}</td>
              <td style={cellR}>{inr(it.taxable_value)}</td>
              {interstate ? <>
                <td style={cellR}>{Number(it.igst_rate) || 0}%</td>
                <td style={cellR}>{inr(it.igst_amt)}</td>
              </> : <>
                <td style={cellR}>{Number(it.cgst_rate) || 0}%</td>
                <td style={cellR}>{inr(it.cgst_amt)}</td>
                <td style={cellR}>{Number(it.sgst_rate) || 0}%</td>
                <td style={cellR}>{inr(it.sgst_amt)}</td>
              </>}
              <td style={cellR}>{inr(it.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals + bank */}
      <div style={{ display: 'flex', border: `1px solid ${HAIR}` }}>
        <div style={{ flex: 1, padding: '12px 14px', borderRight: `1px solid ${HAIR}` }}>
          <div style={sectionLabel}>Bank Details</div>
          <div style={{ ...mono, fontSize: '11.5px', lineHeight: 2, color: 'oklch(32% 0.01 250)' }}>
            ACCOUNT NAME: {firm.bank_account_name || '—'}<br />
            ACCOUNT NUMBER: {firm.bank_account_number || '—'}<br />
            IFSC CODE: {firm.bank_ifsc || '—'}
          </div>
        </div>
        <div style={{ width: '270px', fontSize: '12.5px', padding: '12px 14px' }}>
          <TotalRow label="TAXABLE AMOUNT" value={inr(invoice.taxable_total)} />
          {interstate
            ? <TotalRow label="IGST TOTAL" value={inr(invoice.igst_total)} />
            : <>
              <TotalRow label="CGST TOTAL" value={inr(invoice.cgst_total)} />
              <TotalRow label="SGST TOTAL" value={inr(invoice.sgst_total)} />
            </>}
          <div style={{ ...mono, display: 'flex', justifyContent: 'space-between', padding: '7px 0', marginTop: '4px', borderTop: `2px solid ${ACCENT}`, fontWeight: 700, fontSize: '15px' }}>
            <span>GRAND TOTAL</span><span>₹ {inr(invoice.grand_total)}</span>
          </div>
          <div style={{ fontSize: '10.5px', color: LABEL, marginTop: '4px', fontStyle: 'italic' }}>
            Amount in Words: {invoice.amount_in_words || ''}
          </div>
        </div>
      </div>

      {/* Terms + signature */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderTop: `1px solid ${HAIR}`, paddingTop: '10px' }}>
        <div style={{ maxWidth: '340px' }}>
          <div style={sectionLabel}>Terms &amp; Conditions</div>
          <div style={{ fontSize: '10.5px', lineHeight: 1.6, color: 'oklch(48% 0.01 250)' }}>
            {firm.terms || ''}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: '170px', height: '40px', borderBottom: '1px solid oklch(55% 0.01 250)' }} />
          <div style={{ fontSize: '10.5px', color: 'oklch(45% 0.01 250)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
            Authorized Signatory
          </div>
        </div>
      </div>

      {/* Footer strip */}
      <div style={{ ...mono, display: 'flex', justifyContent: 'space-between', borderTop: `2px solid ${ACCENT}`, paddingTop: '6px', fontSize: '9.5px', color: LABEL, letterSpacing: '0.5px' }}>
        <span>SCALE: NTS</span><span>REV: 00</span><span>SHEET 1 OF 1</span>
        <span>{isProforma ? 'PROFORMA — NOT A TAX INVOICE' : 'THIS IS A COMPUTER GENERATED INVOICE'}</span>
      </div>
    </section>
  )
}

function Th({ children, w, mono: m, r }) {
  return <th style={{ padding: '7px 6px', textAlign: r ? 'right' : 'left', fontWeight: 600, width: w, ...(m ? mono : {}) }}>{children}</th>
}
function TitleRow({ label, value, bold }) {
  return (
    <tr>
      <td style={{ borderTop: `1px solid oklch(80% 0.01 250)`, padding: '4px 8px', color: LABEL, width: '50%' }}>{label}</td>
      <td style={{ borderTop: `1px solid oklch(80% 0.01 250)`, borderLeft: `1px solid oklch(80% 0.01 250)`, padding: '4px 8px', fontWeight: bold ? 700 : 400 }}>{value}</td>
    </tr>
  )
}
function TotalRow({ label, value }) {
  return (
    <div style={{ ...mono, display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: 'oklch(38% 0.01 250)' }}>
      <span>{label}</span><span>{value}</span>
    </div>
  )
}
function CornerTicks() {
  const base = { position: 'absolute', width: '14px', height: '14px', borderColor: ACCENT }
  return (
    <div style={{ position: 'absolute', inset: '14px', pointerEvents: 'none' }}>
      <span style={{ ...base, top: 0, left: 0, borderTop: '2px solid', borderLeft: '2px solid' }} />
      <span style={{ ...base, top: 0, right: 0, borderTop: '2px solid', borderRight: '2px solid' }} />
      <span style={{ ...base, bottom: 0, left: 0, borderBottom: '2px solid', borderLeft: '2px solid' }} />
      <span style={{ ...base, bottom: 0, right: 0, borderBottom: '2px solid', borderRight: '2px solid' }} />
    </div>
  )
}
