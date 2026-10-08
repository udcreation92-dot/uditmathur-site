import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function Alerts({ symbol }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const [comparisonType, setComparisonType] = useState("LTP");
  const [condition, setCondition] = useState("GT");
  const [value, setValue] = useState(0);
  const [name, setName] = useState("");
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await api.listAlerts();
      setAlerts(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!name.trim()) { setPlaceError("Give the alert a name."); return; }
    setPlacing(true); setPlaceError(null);
    try {
      await api.createAlert({
        symbol: symbol.symbol,
        comparison_type: comparisonType,
        condition,
        value: +value,
        name: name.trim(),
      });
      setShowForm(false);
      setName("");
      load();
    } catch (err) {
      setPlaceError(err.message);
    } finally {
      setPlacing(false);
    }
  }

  async function remove(alertId) {
    try {
      await api.deleteAlert(alertId);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggle(alertId) {
    try {
      await api.toggleAlert(alertId);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold text-gray-300">Price Alerts — {symbol.symbol}</h2>
          <button onClick={() => setShowForm(f => !f)}
            className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded font-medium">
            {showForm ? "Cancel" : "+ New Alert"}
          </button>
        </div>

        {showForm && (
          <div className="space-y-3 bg-gray-800/50 rounded p-3">
            <label className="text-xs text-gray-400 flex flex-col gap-1">
              Alert Name
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. TCS crosses 2100" className="input-field" />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                When
                <select value={comparisonType} onChange={e => setComparisonType(e.target.value)} className="input-field">
                  {["LTP", "OPEN", "HIGH", "LOW", "CLOSE"].map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Condition
                <select value={condition} onChange={e => setCondition(e.target.value)} className="input-field">
                  <option value="GT">&gt; Greater than</option>
                  <option value="LT">&lt; Less than</option>
                  <option value="EQ">= Equal to</option>
                </select>
              </label>
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Value (₹)
                <input type="number" step="0.05" value={value} onChange={e => setValue(e.target.value)} className="input-field" />
              </label>
            </div>
            {placeError && <p className="text-red-400 text-xs">{placeError}</p>}
            <button onClick={create} disabled={placing}
              className="w-full py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-sm font-medium">
              {placing ? "Creating…" : "Create Alert"}
            </button>
          </div>
        )}
      </div>

      {loading ? <div className="text-gray-400 text-sm">Loading…</div> :
       error ? <p className="text-red-400 text-sm">{error}</p> :
       alerts.length === 0 ? <p className="text-gray-500 text-sm">No alerts set.</p> : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-2 px-2">Name</th>
                <th className="text-left px-2">Symbol</th>
                <th className="text-left px-2">Condition</th>
                <th className="text-right px-2">Value</th>
                <th className="text-left px-2">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.alert_id} className="border-b border-gray-800/50">
                  <td className="py-1.5 px-2 text-gray-200">{a.name}</td>
                  <td className="px-2 text-gray-300">{a.symbol}</td>
                  <td className="px-2 text-gray-400">{a.comparisonType} {a.condition}</td>
                  <td className="text-right px-2 text-gray-300">{a.value}</td>
                  <td className="px-2">
                    <span className={a.status === 1 ? "text-green-400" : "text-gray-500"}>
                      {a.status === 1 ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="px-2 whitespace-nowrap">
                    <button onClick={() => toggle(a.alert_id)}
                      className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded mr-1">
                      Toggle
                    </button>
                    <button onClick={() => remove(a.alert_id)}
                      className="text-[10px] px-2 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-400 border border-red-800 rounded">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
