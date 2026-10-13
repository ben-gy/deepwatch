// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * cues.ts — deepwatch's sound cues, played through the engine's synth.
 *
 * This file used to be a whole forked `sound.ts`: a private copy of the
 * oscillator/noise graph that existed only because the engine's `SfxName` was a
 * closed union of platformer cue names. Engine v1.3.0 made cue names `string`
 * and added `patches`, so all that survives here is what is genuinely deepwatch's:
 * the cue table, and two behaviours the engine does not provide.
 *
 *  - `surface` is PITCHED BY DEPTH. A shallow card blips high, a deep one low,
 *    so a clean ascending line plays as a descending run of tones and the crew
 *    can hear that they are reading each other well. That is `depthPitch()`,
 *    which is now the engine's `{ pitch }` rather than a bespoke `{ depth }`.
 *  - the countdown beats fire whether or not anything is rendering, because
 *    players watch the gauge, not the overlay.
 *
 * WHY THE try/catch SURVIVED THE MIGRATION (`createGameSfx`): the engine's
 * `createSfx` has no error handling, and `sfx.unlock()` is the FIRST statement in
 * deepwatch's core tap handler (main.ts, `onTap`). A `new AudioContext()` that
 * throws — a hardened anti-fingerprinting extension will do it — would abort the
 * handler before `session.play()` ever ran, so the failure mode is not a silent
 * game, it is an UNTAPPABLE one. Audio is best-effort; it must never be able to
 * take a dive down with it. Deleting this wrapper is a robustness regression, not
 * a cleanup.
 */

import { createSfx, type Patch } from '@ben-gy/game-engine/sound';

/**
 * Deepwatch's cue names. The engine's `SfxName` is `string` (deliberately — a
 * closed union is what forced the fork), so this union is the game's own guard
 * against a typo: `won`/`lost` sit one letter from the engine's built-in
 * `win`/`lose`, and an unknown cue plays silently rather than failing loudly.
 */
export type Cue =
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

/**
 * Every cue is listed explicitly, including `beat`, `go` and `select`, which
 * COLLIDE with engine built-ins at different values — `beat` is a sine here and a
 * triangle in the engine, `go` is a fifth lower, `select` is shorter and quieter.
 * Game patches merge OVER the defaults, so listing them is what keeps the
 * countdown and the UI taps sounding like deepwatch instead of like the engine.
 */
export const CUES: Record<Cue, Patch> = {
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

/**
 * Depth → pitch multiplier. 1.0 at the surface down to 0.38 at the floor of the
 * deck — a bit under an octave and a half.
 *
 * The clamp is load-bearing rather than defensive tidiness: the engine ignores a
 * `pitch` of zero or less outright (`opts.pitch && opts.pitch > 0`), so an
 * unclamped ratio above 1.61 would not play deep, it would silently play at FULL
 * pitch — the opposite of the intended cue.
 */
export function depthPitch(depth: number, deckMax: number): number {
  const ratio = depth / Math.max(1, deckMax);
  return 1 - 0.62 * Math.max(0, Math.min(1, ratio));
}

export interface PlayOpts {
  /** Multiply every frequency in the cue. See `depthPitch`. */
  pitch?: number;
}

export interface GameSfx {
  unlock(): void;
  play(name: Cue, opts?: PlayOpts): void;
  muted(): boolean;
  setMuted(m: boolean): void;
  /** True when every cue in `CUES` is known to the synth. Asserted at boot. */
  ready(): boolean;
}

/**
 * The engine synth, loaded with deepwatch's cues and wrapped so that no audio
 * failure can escape into a gameplay handler. See the file header.
 */
export function createGameSfx(initialMuted = false): GameSfx {
  const sfx = createSfx({ muted: initialMuted, patches: CUES });

  return {
    unlock() {
      try {
        sfx.unlock();
      } catch {
        /* audio is best-effort; never break a dive over a blocked context */
      }
    },
    play(name, opts) {
      try {
        sfx.play(name, opts);
      } catch {
        /* as above — a dive outlives its sound effects */
      }
    },
    muted: () => sfx.muted(),
    setMuted(m) {
      sfx.setMuted(m);
    },
    ready: () => (Object.keys(CUES) as Cue[]).every((c) => sfx.has(c)),
  };
}
