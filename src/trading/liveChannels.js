import { useState, useEffect, useCallback } from "react";

// Built-in channels the Live TV panel seeds with on first run.
//
// Each `url` is an HLS stream (.m3u8). If you have a .m3u playlist file, open it
// and copy the https://…/*.m3u8 line from inside it — that URL goes here.
export const DEFAULT_CHANNELS = [
  {
    id: "bloomberg",
    label: "Bloomberg+",
    url: "https://86ebec83.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/UmFrdXRlblRWLWV1X0Jsb29tYmVyZ1RWUGx1c19ITFM/playlist.m3u8",
  },
  {
    id: "cnbc",
    label: "CNBC Prime",
    url: "https://n18syndication.akamaized.net/bpk-tv/CNBC_Tv18_Prime_HD_NW18_MOB/output01/index.m3u8",
  },
];

export const MAX_CHANNELS = 4;

const STORAGE_KEY = "trading.liveChannels";
const CHANGE_EVENT = "livechannels:changed"; // fires so both LiveTV instances stay in sync

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CHANNELS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, MAX_CHANNELS);
  } catch { /* corrupt/unavailable — fall back to defaults */ }
  return DEFAULT_CHANNELS;
}

function writeStored(channels) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(channels));
  } catch { /* ignore quota/availability errors */ }
  // Notify other hook instances in this same tab (storage event only fires cross-tab).
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

// Shared, persisted channel list. add/remove are capped at MAX_CHANNELS and every
// mounted LiveTV re-reads on change so the right column and the tab stay in step.
export function useLiveChannels() {
  const [channels, setChannels] = useState(readStored);

  useEffect(() => {
    const sync = () => setChannels(readStored());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync); // cross-tab
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const addChannel = useCallback((label, url) => {
    const name = label.trim(), src = url.trim();
    if (!name || !src) return { ok: false, error: "Name and URL are required." };
    const current = readStored();
    if (current.length >= MAX_CHANNELS) return { ok: false, error: `Maximum ${MAX_CHANNELS} streams.` };
    const id = `ch_${Date.now()}`;
    writeStored([...current, { id, label: name, url: src }]);
    return { ok: true };
  }, []);

  const removeChannel = useCallback((id) => {
    writeStored(readStored().filter(c => c.id !== id));
  }, []);

  return { channels, addChannel, removeChannel };
}
