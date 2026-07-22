// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * sound.ts — procedural underwater SFX. Zero asset files, works offline.
 *
 * Adapted from patterns/sound.ts. Two things here are not decoration:
 *
 *  - `surface` is PITCHED BY DEPTH. A shallow card blips high, a deep one low,
 *    so a clean ascending line plays as a descending run of tones and the crew
 *    can hear that they are reading each other well. Getting it wrong sounds
 *    wrong before the screen has finished telling you.
 *  - the countdown beats fire whether or not anything is rendering, because
 *    players watch the gauge, not the overlay.
 */

export type SfxName =
  | 'dive'
  | 'surface'
  | 'misplay'
  | 'tank'
  | 'sonar'
  | 'charge'
  | 'clear'
  | 'won'
  | 'lost'
  | 'beat'
  | 'go'
  | 'select';

interface Patch {
  type: OscillatorType;
  /** [startFreq, endFreq] Hz — glides between them over `dur`. */
  freq: [number, number];
  dur: number;
  gain?: number;
  /** Add a short noise burst (impacts, the tide). */
  noise?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  dive: { type: 'sine', freq: [420, 130], dur: 0.7, gain: 0.24 },
  surface: { type: 'sine', freq: [520, 780], dur: 0.16, gain: 0.2 },
  misplay: { type: 'sawtooth', freq: [190, 48], dur: 0.44, gain: 0.3, noise: true },
  tank: { type: 'sawtooth', freq: [900, 240], dur: 0.5, gain: 0.16, noise: true },
  sonar: { type: 'sine', freq: [1500, 620], dur: 0.85, gain: 0.24 },
  charge: { type: 'triangle', freq: [300, 900], dur: 0.6, gain: 0.14 },
  clear: { type: 'triangle', freq: [560, 1120], dur: 0.42, gain: 0.24 },
  won: { type: 'triangle', freq: [420, 1400], dur: 0.9, gain: 0.28 },
  lost: { type: 'sine', freq: [260, 60], dur: 1.1, gain: 0.28, noise: true },
  beat: { type: 'sine', freq: [660, 660], dur: 0.11, gain: 0.2 },
  go: { type: 'triangle', freq: [520, 1040], dur: 0.3, gain: 0.26 },
  select: { type: 'triangle', freq: [520, 760], dur: 0.07, gain: 0.16 },
};

export interface PlayOpts {
  /**
   * 0..1 — how deep the card was. Shifts `surface` down about an octave and a
   * half across the deck, so the line is audible as well as visible.
   */
  depth?: number;
}

export interface Sfx {
  unlock(): void;
  play(name: SfxName, opts?: PlayOpts): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;

  const ensure = (): AudioContext | null => {
    try {
      if (!ctx) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') void ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },
    play(name, opts) {
      if (muted) return;
      const ac = ensure();
      if (!ac) return;
      try {
        const p = PATCHES[name];
        // Deep cards ring lower. 1.0 at the surface down to ~0.38 at the floor
        // of the deck — a bit under an octave and a half.
        const shift = opts?.depth == null ? 1 : 1 - 0.62 * Math.max(0, Math.min(1, opts.depth));
        const t0 = ac.currentTime;
        const g = ac.createGain();
        g.gain.setValueAtTime(p.gain ?? 0.25, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        g.connect(ac.destination);

        const osc = ac.createOscillator();
        osc.type = p.type;
        osc.frequency.setValueAtTime(Math.max(1, p.freq[0] * shift), t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.freq[1] * shift), t0 + p.dur);
        osc.connect(g);
        osc.start(t0);
        osc.stop(t0 + p.dur);

        if (p.noise) {
          const n = ac.createBufferSource();
          n.buffer = noiseBuffer(ac, p.dur);
          const ng = ac.createGain();
          ng.gain.setValueAtTime((p.gain ?? 0.25) * 0.55, t0);
          ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
          n.connect(ng);
          ng.connect(ac.destination);
          n.start(t0);
          n.stop(t0 + p.dur);
        }
      } catch {
        /* audio is best-effort; never break a dive over a blocked context */
      }
    },
    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}
