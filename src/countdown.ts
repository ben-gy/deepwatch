// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * countdown.ts — 3, 2, 1, DIVE before a level begins.
 *
 * A level never begins the instant the cards appear. Without this, whoever
 * happens to be looking gets a free head start — and in a game where the only
 * information is WHEN someone acts, a head start is not a small unfairness, it
 * poisons the read for the whole level.
 *
 * The AUDIO carries it: players watch the gauge, not the overlay, so each beat
 * fires a sound whether or not anything is rendering.
 *
 * setInterval, never rAF alone: a backgrounded tab pauses rAF, and a countdown
 * that freezes when you glance at another tab strands the rest of the crew.
 */

export interface CountdownOpts {
  from?: number;
  beatMs?: number;
  /** Fires per beat. `n` is 3,2,1 then 0 for DIVE. */
  onBeat: (n: number) => void;
  onDone: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface Countdown {
  cancel(): void;
  done(): boolean;
}

export function startCountdown(opts: CountdownOpts): Countdown {
  const from = opts.from ?? 3;
  const beatMs = opts.beatMs ?? 700;
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let n = from;
  let finished = false;
  let handle: unknown = null;

  opts.onBeat(n);

  const stop = (): void => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };

  handle = setTimer(() => {
    if (finished) return;
    n--;
    opts.onBeat(n);
    if (n <= 0) {
      finished = true;
      stop();
      opts.onDone();
    }
  }, beatMs);

  return {
    cancel() {
      if (finished) return;
      finished = true;
      stop();
    },
    done: () => finished,
  };
}
