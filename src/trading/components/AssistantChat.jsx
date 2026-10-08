import { useState, useRef, useEffect } from "react";
import { api } from "../api";

// Floating "Ask AI" chat box. Talks to POST /assistant/ask (DeepSeek, brevity-tuned). Keeps a
// short in-memory history for the session — nothing is persisted.
export default function AssistantChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role:'user'|'assistant', content}
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, loading, open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const { answer } = await api.askAssistant(next);
      setMessages(m => [...m, { role: "assistant", content: answer }]);
    } catch (err) {
      setError(err.message || "Failed");
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  if (!open) {
    return (
      <button className="tt-ask-fab" onClick={() => setOpen(true)} title="Ask AI">
        ✦ ASK AI
      </button>
    );
  }

  return (
    <div className="tt-ask-panel">
      <div className="tt-ask-head">
        <span className="tt-ask-title">✦ ASK AI</span>
        {messages.length > 0 && (
          <button className="tt-ask-clear" onClick={() => { setMessages([]); setError(null); }}>CLEAR</button>
        )}
        <button className="tt-ask-x" onClick={() => setOpen(false)} title="Close">×</button>
      </div>
      <div className="tt-ask-body" ref={bodyRef}>
        {messages.length === 0 && !loading && (
          <p className="tt-ask-hint">Ask anything — markets, concepts, quick calcs. Answers are kept short.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`tt-ask-msg ${m.role === "user" ? "tt-ask-user" : "tt-ask-ai"}`}>
            {m.content}
          </div>
        ))}
        {loading && <div className="tt-ask-msg tt-ask-ai tt-ask-typing">…thinking</div>}
        {error && <div className="tt-ask-err">{error}</div>}
      </div>
      <div className="tt-ask-input">
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask a question…  (Enter to send)"
        />
        <button onClick={send} disabled={loading || !input.trim()}>SEND</button>
      </div>
    </div>
  );
}
