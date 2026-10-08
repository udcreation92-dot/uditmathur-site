import { useState, useCallback } from "react";
import { comboZerodhaMargin } from "./zerodhaMargin";

// Manages on-demand Zerodha margins for a scanner's result rows. `legsFor(row)` returns the
// combo's legs. `margins` maps row index -> { loading } | { net, gross } | { error }.
// checkOne fetches a single row; checkAll fetches every row (bounded concurrency to respect
// Zerodha rate limits). Nothing runs until a button is clicked.
export function useZerodhaMargins(legsFor) {
  const [margins, setMargins] = useState({});
  const [bulkLoading, setBulkLoading] = useState(false);

  const fetchInto = useCallback(async (i, row) => {
    setMargins(m => ({ ...m, [i]: { loading: true } }));
    try {
      const res = await comboZerodhaMargin(legsFor(row));
      setMargins(m => ({ ...m, [i]: res }));
    } catch (e) {
      setMargins(m => ({ ...m, [i]: { error: e.message } }));
    }
  }, [legsFor]);

  const checkOne = useCallback((i, row) => fetchInto(i, row), [fetchInto]);

  const checkAll = useCallback(async (rows) => {
    if (!rows?.length) return;
    setBulkLoading(true);
    setMargins(Object.fromEntries(rows.map((_, i) => [i, { loading: true }])));
    const CONCURRENCY = 5;  // Kite margin API tolerates this; keeps a ~40-combo auto-pull to a few sec
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        try {
          const res = await comboZerodhaMargin(legsFor(rows[i]));
          setMargins(m => ({ ...m, [i]: res }));
        } catch (e) {
          setMargins(m => ({ ...m, [i]: { error: e.message } }));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    setBulkLoading(false);
  }, [legsFor]);

  const reset = useCallback(() => setMargins({}), []);

  return { margins, bulkLoading, checkOne, checkAll, reset };
}
