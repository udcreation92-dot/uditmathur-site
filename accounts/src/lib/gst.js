// ─── GST / invoice helpers ───────────────────────────────────────────────────

// Indian grouping, 2 decimals: 257000 -> "2,57,000.00"
export function inr(n) {
  const v = Number(n) || 0
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Round to 2 decimals (avoid float drift)
export const round2 = n => Math.round((Number(n) || 0) * 100) / 100

// Interstate when the place-of-supply state differs from the supplier state.
// state_code strings look like "Karnataka, 29"; compare the trailing numeric code.
function stateCode(s) {
  if (!s) return ''
  const m = String(s).match(/(\d{1,2})\s*$/)
  return m ? m[1] : String(s).trim().toLowerCase()
}
export function isInterstate(placeOfSupply, supplierState) {
  const a = stateCode(placeOfSupply), b = stateCode(supplierState)
  if (!a || !b) return false
  return a !== b
}

// Tax for one line. ratePct is the TOTAL GST rate (e.g. 18). Intra-state splits
// into CGST + SGST (half each); inter-state is a single IGST at the full rate.
export function computeItemTax(taxableValue, ratePct, interstate) {
  const tv = round2(taxableValue)
  const rate = Number(ratePct) || 0
  if (interstate) {
    const igst = round2(tv * rate / 100)
    return {
      cgst_rate: 0, cgst_amt: 0, sgst_rate: 0, sgst_amt: 0,
      igst_rate: rate, igst_amt: igst,
      line_total: round2(tv + igst),
    }
  }
  const half = rate / 2
  const cgst = round2(tv * half / 100)
  const sgst = round2(tv * half / 100)
  return {
    cgst_rate: half, cgst_amt: cgst, sgst_rate: half, sgst_amt: sgst,
    igst_rate: 0, igst_amt: 0,
    line_total: round2(tv + cgst + sgst),
  }
}

// Roll an array of computed items into invoice-level totals.
export function invoiceTotals(items) {
  return items.reduce((t, it) => ({
    taxable_total: round2(t.taxable_total + (Number(it.taxable_value) || 0)),
    cgst_total:    round2(t.cgst_total    + (Number(it.cgst_amt)      || 0)),
    sgst_total:    round2(t.sgst_total    + (Number(it.sgst_amt)      || 0)),
    igst_total:    round2(t.igst_total    + (Number(it.igst_amt)      || 0)),
    grand_total:   round2(t.grand_total   + (Number(it.line_total)    || 0)),
  }), { taxable_total: 0, cgst_total: 0, sgst_total: 0, igst_total: 0, grand_total: 0 })
}

// Resolve a work-order stage to a rupee amount.
export function stageAmount(stage, woAmount) {
  if (!stage) return 0
  if (stage.basis === 'percent') return round2((Number(woAmount) || 0) * (Number(stage.value) || 0) / 100)
  return round2(Number(stage.value) || 0)
}

// ─── Amount in words (Indian system) ─────────────────────────────────────────

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigits(n) {
  if (n < 20) return ONES[n]
  const t = Math.floor(n / 10), o = n % 10
  return TENS[t] + (o ? ' ' + ONES[o] : '')
}

function threeDigits(n) {
  const h = Math.floor(n / 100), r = n % 100
  let s = ''
  if (h) s += ONES[h] + ' Hundred'
  if (r) s += (s ? ' ' : '') + twoDigits(r)
  return s
}

// 303260 -> "Three Lakh Three Thousand Two Hundred Sixty"
function numToWords(num) {
  if (num === 0) return 'Zero'
  let words = ''
  const crore = Math.floor(num / 10000000); num %= 10000000
  const lakh  = Math.floor(num / 100000);   num %= 100000
  const thou  = Math.floor(num / 1000);      num %= 1000
  const rest  = num
  if (crore) words += twoDigits(crore) + ' Crore '
  if (lakh)  words += twoDigits(lakh)  + ' Lakh '
  if (thou)  words += twoDigits(thou)  + ' Thousand '
  if (rest)  words += threeDigits(rest)
  return words.trim().replace(/\s+/g, ' ')
}

// 303260.5 -> "Rupees Three Lakh Three Thousand Two Hundred Sixty and Fifty Paise Only"
export function amountInWords(amount) {
  const v = round2(amount)
  const rupees = Math.floor(v)
  const paise = Math.round((v - rupees) * 100)
  let s = 'Rupees ' + numToWords(rupees)
  if (paise) s += ' and ' + numToWords(paise) + ' Paise'
  return s + ' Only'
}

// Indian financial year label for a date: Apr–Mar. 2026-07-16 -> "2026-27".
export function finYear(d) {
  const dt = typeof d === 'string' ? new Date(d + 'T00:00:00') : d
  const y = dt.getFullYear(), m = dt.getMonth() // 0=Jan … 3=Apr
  const start = m >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

// DD/MM/YYYY from an ISO date string (yyyy-mm-dd) or Date
export function ddmmyyyy(d) {
  if (!d) return ''
  const dt = typeof d === 'string' ? new Date(d + 'T00:00:00') : d
  if (isNaN(dt)) return String(d)
  const p = n => String(n).padStart(2, '0')
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`
}
