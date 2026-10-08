// Controlled display for one row's Zerodha margin. State lives in the scanner (via
// useZerodhaMargins) so a per-row "Margin" click and the bulk "Check all" share one source of
// truth. `entry` is undefined | { loading } | { net, gross } | { error }; `onCheck` fetches it.
export default function ZerodhaMarginButton({ entry, onCheck }) {
  if (entry?.loading) {
    return <span className="text-[10px] text-gray-400 whitespace-nowrap">…</span>;
  }
  if (entry?.net != null) {
    const benefit = entry.gross != null && entry.gross > entry.net ? entry.gross - entry.net : 0;
    return (
      <span className="text-[10px] text-blue-300 whitespace-nowrap"
        title={`Zerodha basket margin (NRML).${benefit ? ` Standalone ₹${Math.round(entry.gross).toLocaleString()}, hedge benefit ₹${Math.round(benefit).toLocaleString()}.` : ""} Click ↻ to recheck.`}>
        ₹{Math.round(entry.net).toLocaleString()}
        <button onClick={onCheck} className="ml-1 text-gray-500 hover:text-gray-300" title="Recheck">↻</button>
      </span>
    );
  }
  if (entry?.error) {
    return (
      <button onClick={onCheck} title={entry.error}
        className="text-[10px] px-2 py-1 bg-red-900/40 text-red-300 hover:bg-red-900/60 rounded whitespace-nowrap">
        Retry margin
      </button>
    );
  }
  return (
    <button onClick={onCheck}
      className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded font-medium whitespace-nowrap"
      title="Fetch this combo's margin from Zerodha (basket, with hedge benefit)">
      Margin
    </button>
  );
}
