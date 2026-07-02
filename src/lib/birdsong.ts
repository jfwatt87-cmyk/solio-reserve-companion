/**
 * Procedural bird calls via the Web Audio API.
 *
 * Real recordings would be embedded in production; for this offline PoC each
 * species has a short synthesised motif so the "tap to hear the call" feature
 * works with zero audio assets and zero network. It is evocative, not a
 * faithful recording.
 */

export interface Note {
  /** Frequency in Hz (start). */
  f: number;
  /** Optional glide end frequency. */
  f2?: number;
  /** Duration in seconds. */
  d: number;
  type?: OscillatorType;
  /** Gap after the note, seconds. */
  gap?: number;
}

let active: AudioContext | null = null;

/** Play a sequence of notes. Returns total duration (seconds). */
export function playSong(notes: Note[], onEnd?: () => void): number {
  stopSong();
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    onEnd?.();
    return 0;
  }
  const ctx = new Ctx();
  active = ctx;

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  let t = ctx.currentTime + 0.06;
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.setValueAtTime(n.f, t);
    if (n.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(40, n.f2), t + n.d);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + n.d);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + n.d + 0.03);
    t += n.d + (n.gap ?? 0.04);
  }

  const total = t - ctx.currentTime;
  window.setTimeout(() => {
    if (active === ctx) {
      ctx.close();
      active = null;
    }
    onEnd?.();
  }, total * 1000 + 120);
  return total;
}

export function stopSong() {
  if (active) {
    try {
      active.close();
    } catch {
      /* already closed */
    }
    active = null;
  }
}
