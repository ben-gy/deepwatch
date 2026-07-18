/**
 * countdown.test.ts — 3, 2, 1, DIVE.
 *
 * It matters more here than in most games: the only information anyone has is
 * WHEN someone acts, so a level that begins the instant the cards appear hands a
 * head start to whoever happened to be looking and poisons the read for the
 * whole level.
 *
 * Timers are injected so this needs no wall clock.
 */

import { describe, expect, it } from 'vitest';
import { startCountdown } from '../src/countdown';

/** A hand-cranked stand-in for setInterval. */
function fakeTimer() {
  let fn: (() => void) | null = null;
  return {
    set: (f: () => void) => {
      fn = f;
      return 1;
    },
    clear: () => {
      fn = null;
    },
    tick(n = 1): void {
      for (let i = 0; i < n; i++) fn?.();
    },
    live: () => fn !== null,
  };
}

describe('startCountdown', () => {
  it('beats 3, 2, 1, 0 and then finishes', () => {
    const t = fakeTimer();
    const beats: number[] = [];
    let done = false;
    startCountdown({
      onBeat: (n) => beats.push(n),
      onDone: () => {
        done = true;
      },
      setTimer: t.set,
      clearTimer: t.clear,
    });
    expect(beats).toEqual([3]);
    expect(done).toBe(false);
    t.tick(3);
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(done).toBe(true);
  });

  it('fires the opening beat immediately, so the screen is never blank', () => {
    const t = fakeTimer();
    const beats: number[] = [];
    startCountdown({ onBeat: (n) => beats.push(n), onDone: () => {}, setTimer: t.set, clearTimer: t.clear });
    expect(beats).toHaveLength(1);
  });

  it('stops its timer once done rather than leaking it', () => {
    const t = fakeTimer();
    startCountdown({ onBeat: () => {}, onDone: () => {}, setTimer: t.set, clearTimer: t.clear });
    t.tick(3);
    expect(t.live()).toBe(false);
  });

  it('cancels cleanly on teardown and never calls onDone', () => {
    const t = fakeTimer();
    let done = false;
    const c = startCountdown({
      onBeat: () => {},
      onDone: () => {
        done = true;
      },
      setTimer: t.set,
      clearTimer: t.clear,
    });
    c.cancel();
    t.tick(5);
    // The guarantee that matters: a cancelled countdown never starts the level.
    expect(done).toBe(false);
    expect(t.live()).toBe(false);
    // `done()` reports "no longer running", not "reached zero" — which is what
    // makes a second cancel a no-op rather than a double teardown.
    expect(c.done()).toBe(true);
  });

  it('ignores a cancel after it already finished', () => {
    const t = fakeTimer();
    let dones = 0;
    const c = startCountdown({
      onBeat: () => {},
      onDone: () => dones++,
      setTimer: t.set,
      clearTimer: t.clear,
    });
    t.tick(3);
    c.cancel();
    t.tick(3);
    expect(dones).toBe(1);
  });

  it('honours a custom length', () => {
    const t = fakeTimer();
    const beats: number[] = [];
    startCountdown({
      from: 5,
      onBeat: (n) => beats.push(n),
      onDone: () => {},
      setTimer: t.set,
      clearTimer: t.clear,
    });
    t.tick(5);
    expect(beats).toEqual([5, 4, 3, 2, 1, 0]);
  });
});
