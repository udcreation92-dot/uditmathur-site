import { useState, useEffect } from "react";
import { api } from "../api";

// Fyers session status hook. Returns { status: "checking"|"loggedOut"|"loggedIn", error, startLogin }.
// Lets the app render Fyers-independent tabs (News, Calendar, Live TV) without a login, and gate
// only the trading tools behind it.
export function useAuthStatus() {
  const [status, setStatus] = useState("checking");
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("fyers_login")) {
      if (params.get("fyers_login") === "error") setError("Fyers login failed — please try again.");
      params.delete("fyers_login");
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    check();
  }, []);

  async function check() {
    try {
      const { logged_in } = await api.authStatus();
      setStatus(logged_in ? "loggedIn" : "loggedOut");
    } catch {
      setStatus("loggedOut");
    }
  }

  async function startLogin() {
    setError(null);
    try {
      const { url } = await api.getLoginUrl();
      window.location.href = url;
    } catch (err) {
      setError(err.message);
    }
  }

  return { status, error, startLogin, recheck: check };
}

// The "Connect Fyers" card — shown in place of a trading tool's content when logged out.
export function LoginPrompt({ error, onLogin, compact = false }) {
  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-lg p-6 ${compact ? "" : "max-w-md"}`}>
      <h1 className="text-lg font-bold text-white mb-2">Connect Fyers Account</h1>
      <p className="text-sm text-gray-400 mb-4">
        This tool needs live market data. Click below — you'll be redirected to Fyers to log in, then
        brought straight back here automatically. (News, Calendar and Live TV work without logging in.)
      </p>
      <button onClick={onLogin} className="py-2.5 px-6 bg-blue-600 hover:bg-blue-700 rounded text-sm font-semibold">
        Login with Fyers
      </button>
      {error && <p className="text-red-400 text-sm mt-3 bg-red-900/20 border border-red-800 rounded p-2">{error}</p>}
    </div>
  );
}

// Back-compat default wrapper (unused by TradingApp now, kept for any other caller).
export default function LoginGate({ children }) {
  const { status, error, startLogin } = useAuthStatus();
  if (status === "checking") {
    return <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">Checking session…</div>;
  }
  if (status === "loggedIn") return children;
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-4">
      <LoginPrompt error={error} onLogin={startLogin} />
    </div>
  );
}
