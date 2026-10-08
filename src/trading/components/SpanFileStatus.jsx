import { useState, useEffect } from "react";
import { api } from "../api";

export default function SpanFileStatus() {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  function load() {
    api.getSpanWatchStatus().then(setStatus).catch(err => setError(err.message));
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  async function checkNow() {
    setChecking(true); setError(null);
    try {
      setStatus(await api.checkSpanNow());
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="border-t border-gray-800 mt-3 pt-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-gray-400 font-medium">NSE SPAN files (checked hourly, saved to TradingData\SPAN):</span>
        <button onClick={checkNow} disabled={checking}
          className="px-3 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded text-gray-300">
          {checking ? "Checking…" : "Check Now"}
        </button>
        {status?.last_checked && (
          <span className="text-gray-500">Last checked: {new Date(status.last_checked + "Z").toLocaleString()}</span>
        )}
      </div>
      {error && <p className="text-red-400 mt-2">{error}</p>}
      {status?.last_error && <p className="text-red-400 mt-2">{status.last_error}</p>}
      {status?.local_files?.length > 0 && (
        <p className="text-gray-500 mt-2">
          Latest on disk: {status.local_files[status.local_files.length - 1]} ({status.local_files.length} total)
        </p>
      )}
    </div>
  );
}
