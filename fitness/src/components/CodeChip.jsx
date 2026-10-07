import { useState } from 'react'

export default function CodeChip({ code }) {
  const [copied, setCopied] = useState(false)
  const copy = async (e) => {
    e.stopPropagation()
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked */ }
  }
  return (
    <button type="button" onClick={copy} title="Copy code"
      className="inline-flex items-center gap-1.5 rounded-md bg-neutral-100 px-2 py-1 font-mono text-sm font-bold tracking-widest hover:bg-neutral-200">
      {code}<span className="text-xs font-sans font-semibold tracking-normal text-neutral-500">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}
