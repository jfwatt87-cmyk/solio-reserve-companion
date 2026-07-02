import { useEffect, useRef, useState } from "react";
import { BIRDS, type Bird } from "../data/birds";
import { playSong, stopSong } from "../lib/birdsong";
import { BirdArt } from "./BirdArt";

type IdState = "idle" | "listening" | "analysing" | "result";

export function BirdsTab() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [idState, setIdState] = useState<IdState>("idle");
  const [match, setMatch] = useState<Bird | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [micDenied, setMicDenied] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => () => { clearTimers(); stopMic(); stopSong(); }, []);

  function play(b: Bird) {
    if (playingId === b.id) {
      stopSong();
      setPlayingId(null);
      return;
    }
    setPlayingId(b.id);
    playSong(b.song, () => setPlayingId((id) => (id === b.id ? null : id)));
  }

  async function identify() {
    clearTimers();
    setMatch(null);
    setMicDenied(false);
    setIdState("listening");
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicDenied(true); // continue with the simulated flow regardless
    }
    timers.current.push(window.setTimeout(() => setIdState("analysing"), 3200));
    timers.current.push(
      window.setTimeout(() => {
        stopMic();
        setMatch(BIRDS[Math.floor(Math.random() * BIRDS.length)]);
        setConfidence(82 + Math.floor(Math.random() * 15));
        setIdState("result");
      }, 4700),
    );
  }

  function cancel() { clearTimers(); stopMic(); setIdState("idle"); setMatch(null); }
  function stopMic() { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
  function clearTimers() { timers.current.forEach((t) => clearTimeout(t)); timers.current = []; }

  return (
    <div className="list">
      {/* Song identifier */}
      <div className="bird-id">
        {idState === "idle" && (
          <>
            <div className="bird-id-head">
              <span className="bird-id-mic">🎙️</span>
              <div>
                <div className="bird-id-title">Identify a bird by its song</div>
                <div className="bird-id-sub">Point your phone toward the bird and tap to listen.</div>
              </div>
            </div>
            <button className="btn btn-accent block" onClick={identify}>● Listen &amp; identify</button>
          </>
        )}

        {idState === "listening" && (
          <div className="bird-id-active">
            <Equaliser />
            <div className="bird-id-title">Listening…</div>
            <div className="bird-id-sub">{micDenied ? "No microphone — running a sample." : "Capturing the call around you."}</div>
            <button className="btn btn-ghost-dark sm" onClick={cancel}>Cancel</button>
          </div>
        )}

        {idState === "analysing" && (
          <div className="bird-id-active">
            <div className="spinner" />
            <div className="bird-id-title">Matching…</div>
            <div className="bird-id-sub">Comparing against Solio's bird library.</div>
          </div>
        )}

        {idState === "result" && match && (
          <div className="bird-id-result">
            <BirdArt bird={match} size={72} />
            <div className="bird-id-result-main">
              <div className="bird-id-sub">Best match · {confidence}%</div>
              <div className="bird-id-title">{match.name}</div>
              <div className="bird-id-latin">{match.latin}</div>
              <div className="bird-id-actions">
                <button className="btn btn-accent sm" onClick={() => play(match)}>
                  {playingId === match.id ? "■ Stop" : "▶ Hear call"}
                </button>
                <button className="btn btn-ghost-dark sm" onClick={cancel}>Try again</button>
              </div>
            </div>
          </div>
        )}
      </div>
      {idState === "result" && (
        <div className="bird-sim-note">🔬 Identification is simulated for this proof of concept.</div>
      )}

      <p className="hint">{BIRDS.length} of 300+ species recorded at Solio. Tap a bird to hear its call.</p>

      {BIRDS.map((b) => (
        <div key={b.id} className={`card bird-card ${playingId === b.id ? "sel" : ""}`}>
          <BirdArt bird={b} />
          <div className="card-main">
            <div className="card-title">{b.name}</div>
            <div className="card-sub bird-latin">{b.latin}</div>
            <div className="card-sub">{b.blurb}</div>
          </div>
          <div className="card-side">
            <button className="btn btn-accent sm" onClick={() => play(b)}>
              {playingId === b.id ? "■ Stop" : "▶ Call"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Equaliser() {
  return (
    <div className="eq" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
}
