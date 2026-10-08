import { useState, useEffect, useRef } from "react";
import Hls from "hls.js";
import { useLiveChannels, MAX_CHANNELS } from "../liveChannels";
import { useTradingEvents, EVENT_TYPE_LABELS } from "../useTradingEvents";

// Shared "the fullscreen wall is open" flag so the ordinary players (right column, Live TV tab)
// can pause while the wall owns the screen — otherwise we'd decode the wall's tiles AND the
// players behind it at the same time. Tiny module-level pub/sub, mirrors useLiveChannels.
let _wallActive = false;
const _wallSubs = new Set();
function setWallActive(v) { _wallActive = v; _wallSubs.forEach(fn => fn(v)); }
function useWallActive() {
  const [v, setV] = useState(_wallActive);
  useEffect(() => { _wallSubs.add(setV); return () => { _wallSubs.delete(setV); }; }, []);
  return v;
}

// True while this browser tab is foregrounded. Background tabs shouldn't burn CPU/bandwidth
// decoding live video the user can't see.
function usePageVisible() {
  const [v, setV] = useState(typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const h = () => setV(!document.hidden);
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, []);
  return v;
}

// Attaches an HLS stream to a <video>. Chrome/Firefox need hls.js; Safari plays
// .m3u8 natively so we fall back to setting src directly. Returns a cleanup fn.
function attachStream(video, url) {
  const noop = { destroy() {}, setActive() {} };
  if (!video || !url) return noop;

  if (Hls.isSupported()) {
    // Tuned for smoothness over latency: these are TV news channels, not a trading feed, so a
    // deep buffer that rides through network hiccups matters far more than staying at the live
    // edge. lowLatencyMode OFF + a large back/forward buffer = far fewer mid-stream pauses.
    // capLevelToPlayerSize picks a rendition matching the on-screen pixel size — so a small wall
    // tile pulls ~360-480p instead of 1080p, which is the big bandwidth win when 4 play at once.
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      capLevelToPlayerSize: true,
      maxBufferLength: 30,        // seconds of forward buffer to build up (default 30, kept explicit)
      maxMaxBufferLength: 120,    // allow it to grow this far when bandwidth permits
      backBufferLength: 30,
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {}); // muted autoplay; ignore if blocked
    });
    // Self-heal instead of freezing: on a fatal network/media error, try the built-in recovery
    // paths rather than leaving a dead player. Non-fatal errors hls.js already handles internally.
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else hls.destroy();
    });
    return {
      destroy: () => hls.destroy(),
      // Pausing stops the DOWNLOAD (stopLoad), not just playback, so an idle player uses no
      // bandwidth. Resuming jumps back to the live edge.
      setActive: (on) => {
        if (on) { hls.startLoad(); video.play().catch(() => {}); }
        else { video.pause(); hls.stopLoad(); }
      },
    };
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    const onLoaded = () => video.play().catch(() => {});
    video.addEventListener("loadedmetadata", onLoaded);
    return {
      destroy: () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeAttribute("src");
        video.load();
      },
      setActive: (on) => { if (on) video.play().catch(() => {}); else video.pause(); },
    };
  }

  return noop;
}

// A single channel <video>. `bare` = video-wall cell (no chrome, object-cover, edge to edge).
// `isWallTile` marks the wall's own tiles so they keep playing while the wall is open (only the
// players BEHIND the wall pause).
function ChannelPlayer({ channel, fill = false, bare = false, isWallTile = false, muted = true, onToggleMute }) {
  const [error, setError] = useState(null);
  const videoRef = useRef(null);
  const ctrlRef = useRef(null);

  const pageVisible = usePageVisible();
  const wallActive = useWallActive();
  // Decode only when the tab is foregrounded, and (for ordinary players) only when the fullscreen
  // wall isn't the thing on screen. Wall tiles ignore wallActive — they ARE the wall.
  const active = pageVisible && (isWallTile || !wallActive);

  useEffect(() => {
    setError(null);
    if (!channel?.url) {
      setError("No stream URL configured for this channel yet.");
      return;
    }
    const ctrl = attachStream(videoRef.current, channel.url);
    ctrlRef.current = ctrl;
    return () => { ctrl.destroy(); ctrlRef.current = null; };
  }, [channel?.id, channel?.url]);

  useEffect(() => { ctrlRef.current?.setActive(active); }, [active]);

  // Drive muting imperatively: the video must START muted for autoplay to be allowed, so we keep
  // the `muted` attribute and flip the live property afterwards when the user unmutes a tile.
  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);

  if (bare) {
    return (
      <div className="relative bg-black w-full h-full min-h-0 overflow-hidden">
        <video ref={videoRef} className="w-full h-full object-cover bg-black" muted autoPlay playsInline />
        <span className="absolute top-1.5 left-2 text-[11px] font-semibold text-white/80 bg-black/40 px-1.5 rounded pointer-events-none">
          {channel.label}
        </span>
        {onToggleMute && (
          <button onClick={onToggleMute}
            className={`absolute bottom-2 left-2 flex items-center gap-1 text-xs px-2 py-1 rounded backdrop-blur ${
              muted ? "bg-black/50 text-white/80 hover:bg-black/70" : "bg-blue-600 text-white"
            }`}
            title={muted ? "Unmute this stream" : "Mute"}>
            {muted ? "🔇" : "🔊"} <span className="hidden sm:inline">{muted ? "Unmute" : "Sound on"}</span>
          </button>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-center p-4">
            <p className="text-xs text-gray-400">{error}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`flex flex-col bg-gray-900 border border-gray-800 rounded-lg overflow-hidden ${fill ? "flex-1 min-h-0" : ""}`}>
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-gray-800">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        <h3 className="text-[11px] font-semibold text-gray-200">{channel.label}</h3>
      </div>
      <div className={`relative bg-black ${fill ? "flex-1 min-h-0" : "aspect-video"}`}>
        <video ref={videoRef} className="w-full h-full object-contain bg-black" controls muted autoPlay playsInline />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-center p-4">
            <p className="text-xs text-gray-400">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Explicit grid for the edge-to-edge wall — BOTH columns and rows must be defined, otherwise the
// implicit rows collapse to the videos' intrinsic height instead of splitting the screen evenly.
// 1 → single, 2 → side by side, 3–4 → 2×2.
function wallGrid(n) {
  if (n <= 1) return "grid-cols-1 grid-rows-1";
  if (n === 2) return "grid-cols-2 grid-rows-1";
  return "grid-cols-2 grid-rows-2";
}

// Fullscreen video wall: every stream edge to edge, alerts the only overlay.
function VideoWall({ channels, onExit }) {
  const ref = useRef(null);
  const { events, dismiss } = useTradingEvents();
  // At most one tile plays audio at a time — overlapping channels would be unlistenable.
  const [unmutedId, setUnmutedId] = useState(null);

  useEffect(() => {
    const el = ref.current;
    setWallActive(true); // pause the players behind the wall while it owns the screen
    el?.requestFullscreen?.().catch(() => {}); // gesture came from the button click
    const onChange = () => { if (!document.fullscreenElement) onExit(); };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      setWallActive(false);
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, [onExit]);

  return (
    <div ref={ref} className="fixed inset-0 z-50 bg-black">
      <div className={`grid h-full w-full gap-0 ${wallGrid(channels.length)}`}>
        {channels.map(c => (
          <ChannelPlayer key={c.id} channel={c} bare isWallTile
            muted={unmutedId !== c.id}
            onToggleMute={() => setUnmutedId(id => (id === c.id ? null : c.id))} />
        ))}
      </div>

      {/* The only overlay: live alerts, when there are any. */}
      {events.length > 0 && (
        <div className="absolute top-3 right-3 w-72 max-w-[90vw] space-y-2 pointer-events-none">
          {events.slice(0, 6).map(e => (
            <div key={e.id} className="pointer-events-auto bg-gray-900/90 backdrop-blur border border-blue-700/60 rounded-lg px-3 py-2 shadow-lg">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-blue-300">{EVENT_TYPE_LABELS[e.type] || e.type}</p>
                  <p className="text-xs text-gray-100 mt-0.5">{e.title}</p>
                  {e.body && <p className="text-[10px] text-gray-400 mt-0.5">{e.body}</p>}
                </div>
                <button onClick={() => dismiss([e.id])} className="text-gray-400 hover:text-white text-sm leading-none" title="Dismiss">×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button onClick={onExit}
        className="absolute bottom-3 right-3 text-xs bg-gray-900/80 hover:bg-gray-800 text-gray-200 border border-gray-700 rounded px-3 py-1.5">
        Exit fullscreen (Esc)
      </button>
    </div>
  );
}

function ManagePanel({ channels, addChannel, removeChannel, onClose }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState(null);
  const full = channels.length >= MAX_CHANNELS;

  function submit() {
    const res = addChannel(label, url);
    if (res.ok) { setLabel(""); setUrl(""); setError(null); }
    else setError(res.error);
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-gray-300">Manage Streams ({channels.length}/{MAX_CHANNELS})</h4>
        <button onClick={onClose} className="text-[10px] text-gray-500 hover:text-gray-300">Close</button>
      </div>

      <div className="space-y-1.5">
        {channels.map(c => (
          <div key={c.id} className="flex items-center gap-2 text-xs">
            <span className="text-gray-300 truncate flex-1" title={c.url}>{c.label}</span>
            <button onClick={() => removeChannel(c.id)} className="text-[10px] text-gray-500 hover:text-red-400">Remove</button>
          </div>
        ))}
      </div>

      <div className="space-y-1.5 pt-1 border-t border-gray-800">
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Channel name" disabled={full}
          className="input-field text-xs w-full disabled:opacity-50" />
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="HLS stream URL (.m3u8)" disabled={full}
          className="input-field text-xs w-full disabled:opacity-50" />
        <button onClick={submit} disabled={full || !label.trim() || !url.trim()}
          className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-xs font-medium">
          {full ? `Maximum ${MAX_CHANNELS} streams` : "Add Stream"}
        </button>
        {error && <p className="text-red-400 text-[10px]">{error}</p>}
      </div>
    </div>
  );
}

// compact → stacked tiles for the right column (no controls). full page → stacked tiles
// plus the manage panel and the fullscreen-wall launcher. Every channel streams at once.
export default function LiveTV({ compact = false }) {
  const { channels, addChannel, removeChannel } = useLiveChannels();
  const [showManage, setShowManage] = useState(false);
  const [wall, setWall] = useState(false);
  // Compact (right-column) player can be closed to stop its streams and free CPU. Persisted so it
  // stays closed across reloads; the full Live TV tab is unaffected.
  const [closed, setClosed] = useState(() => compact && localStorage.getItem("trading.liveTvClosed") === "1");
  function setClosedPersist(v) {
    setClosed(v);
    try { localStorage.setItem("trading.liveTvClosed", v ? "1" : "0"); } catch { /* ignore */ }
  }

  if (compact) {
    if (closed) {
      return (
        <button onClick={() => setClosedPersist(false)}
          className="w-full text-xs text-gray-400 hover:text-white bg-gray-900 border border-gray-800 rounded-lg py-1.5">
          ▶ Show Live TV
        </button>
      );
    }
    return (
      <div className="flex flex-col gap-2 w-full">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-200 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> Live TV
          </h3>
          <button onClick={() => setClosedPersist(true)} title="Close to stop the streams and save CPU"
            className="text-[10px] text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-0.5">
            ✕ Close
          </button>
        </div>
        {channels.map(c => <ChannelPlayer key={c.id} channel={c} />)}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> Live TV ({channels.length})
        </h3>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setWall(true)} disabled={channels.length === 0}
            className="text-[11px] text-gray-200 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2.5 py-1 disabled:opacity-50">
            ⛶ Fullscreen wall
          </button>
          <button onClick={() => setShowManage(m => !m)}
            className="text-[11px] text-gray-400 hover:text-white border border-gray-700 rounded px-2.5 py-1">
            {showManage ? "Hide" : "Add / manage"}
          </button>
        </div>
      </div>

      {showManage && (
        <ManagePanel channels={channels} addChannel={addChannel} removeChannel={removeChannel}
          onClose={() => setShowManage(false)} />
      )}

      <div className="flex flex-col gap-2">
        {channels.length === 0
          ? <p className="text-xs text-gray-500 p-4 text-center">No streams — use “Add / manage” to add one.</p>
          : channels.map(c => <ChannelPlayer key={c.id} channel={c} />)}
      </div>

      {wall && channels.length > 0 && <VideoWall channels={channels} onExit={() => setWall(false)} />}
    </div>
  );
}
