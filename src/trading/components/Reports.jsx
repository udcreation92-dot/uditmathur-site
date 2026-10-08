import { useState, useEffect } from "react";
import { api } from "../api";

function GenericTable({ rows, columns }) {
  if (rows.length === 0) return <p className="text-gray-500 text-sm">No records.</p>;
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            {columns.map(c => <th key={c.key} className="text-left py-2 px-2">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-gray-800/50">
              {columns.map(c => (
                <td key={c.key} className="py-1.5 px-2 text-gray-300">{c.render ? c.render(r) : r[c.key] ?? "-"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SECTIONS = {
  tradebook: {
    label: "Tradebook", fetch: api.getTradebook,
    columns: [
      { key: "symbol", label: "Symbol" },
      { key: "side", label: "Side", render: r => <span className={r.side === 1 ? "text-green-400" : "text-red-400"}>{r.side === 1 ? "BUY" : "SELL"}</span> },
      { key: "tradedQty", label: "Qty" },
      { key: "tradePrice", label: "Price" },
      { key: "tradeValue", label: "Value" },
      { key: "orderDateTime", label: "Time" },
    ],
  },
  holdings: {
    label: "Holdings", fetch: api.getHoldings,
    columns: [
      { key: "symbol", label: "Symbol" },
      { key: "quantity", label: "Qty" },
      { key: "costPrice", label: "Avg Cost" },
      { key: "ltp", label: "LTP" },
      { key: "pl", label: "P&L" },
    ],
  },
  ledger: {
    label: "Ledger", fetch: api.getLedger,
    columns: [
      { key: "description", label: "Description" },
      { key: "credit_amount", label: "Credit" },
      { key: "debit_amount", label: "Debit" },
      { key: "running_balance", label: "Balance" },
      { key: "date", label: "Date", render: r => r.date ? new Date(r.date).toLocaleDateString() : "-" },
    ],
  },
  "realised-pnl": {
    label: "Realised P&L", fetch: api.getRealisedPnl,
    columns: [
      { key: "symbol", label: "Symbol" },
      { key: "qty", label: "Qty" },
      { key: "buyAverage", label: "Buy Avg" },
      { key: "sellAverage", label: "Sell Avg" },
      { key: "pl", label: "P&L" },
    ],
  },
  "tax-pnl": {
    label: "Tax P&L", fetch: api.getTaxPnl,
    columns: [
      { key: "symbol", label: "Symbol" },
      { key: "qty", label: "Qty" },
      { key: "pl", label: "P&L" },
      { key: "taxCategory", label: "Category" },
    ],
  },
  charges: {
    label: "Charges", fetch: api.getCharges,
    columns: [
      { key: "segment", label: "Segment" },
      { key: "brokerage", label: "Brokerage" },
      { key: "totalTax", label: "Total Tax" },
      { key: "totalCharges", label: "Total Charges" },
    ],
  },
  "zerodha-holdings": {
    label: "Zerodha Holdings", fetch: api.zerodhaGetHoldings,
    columns: [
      { key: "tradingsymbol", label: "Symbol" },
      { key: "quantity", label: "Qty" },
      { key: "average_price", label: "Avg Cost" },
      { key: "last_price", label: "LTP" },
      { key: "pnl", label: "P&L" },
    ],
  },
  "zerodha-orders": {
    label: "Zerodha Orders", fetch: api.zerodhaGetOrderBook,
    columns: [
      { key: "tradingsymbol", label: "Symbol" },
      { key: "transaction_type", label: "Side", render: r => <span className={r.transaction_type === "BUY" ? "text-green-400" : "text-red-400"}>{r.transaction_type}</span> },
      { key: "quantity", label: "Qty" },
      { key: "price", label: "Price" },
      { key: "status", label: "Status" },
      { key: "order_timestamp", label: "Time" },
    ],
  },
  "zerodha-trades": {
    label: "Zerodha Tradebook", fetch: api.zerodhaGetTrades,
    columns: [
      { key: "tradingsymbol", label: "Symbol" },
      { key: "transaction_type", label: "Side", render: r => <span className={r.transaction_type === "BUY" ? "text-green-400" : "text-red-400"}>{r.transaction_type}</span> },
      { key: "quantity", label: "Qty" },
      { key: "average_price", label: "Price" },
      { key: "fill_timestamp", label: "Time" },
    ],
  },
};

export default function Reports() {
  const [section, setSection] = useState("tradebook");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    SECTIONS[section].fetch()
      .then(data => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [section]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {Object.entries(SECTIONS).map(([id, s]) => (
          <button key={id} onClick={() => setSection(id)}
            className={`px-3 py-1.5 rounded text-sm ${section === id ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
            {s.label}
          </button>
        ))}
      </div>

      {loading ? <div className="text-gray-400 text-sm">Loading…</div> :
       error ? <p className="text-red-400 text-sm">{error}</p> :
       <GenericTable rows={rows} columns={SECTIONS[section].columns} />}
    </div>
  );
}
