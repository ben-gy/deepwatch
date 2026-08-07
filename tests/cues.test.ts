/**
 * cues.test.ts — the sound cue table, after `src/sound.ts` (a forked copy of the
 * engine synth) was deleted in favour of `@ben-gy/game-engine/sound`.
 *
 * Two of these tests exist because the migration could have silently changed the
 * game rather than failing loudly:
 *
 *  - the engine MERGES a game's patches over its own built-ins, and three of
 *    deepwatch's cue names collide with built-ins at different values. Drop one
 *    from CUES and the countdown quietly starts sounding like the engine's.
 *  - the engine's `createSfx` has no error handling, and `sfx.unlock()` is the
 *    first statement in the core tap handler. Without the wrapper, a blocked
 *    AudioContext does not mute the game, it makes it untappable.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PATCHES } from '@ben-gy/game-engine/sound';
import { CUES, createGameSfx, depthPitch, type Cue } from '../src/cues';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the cue table replaces the forked synth', () => {
  it('every cue main.ts plays is defined', () => {
    const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    const played = [...main.matchAll(/sfx\.play\(\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(played.length).toBeGreaterThan(8);
    for (const cue of played) {
      expect(Object.keys(CUES), `main.ts plays '${cue}'`).toContain(cue);
    }
  });

  it('the synth knows every cue once the table is loaded', () => {
    expect(createGameSfx(true).ready()).toBe(true);
  });

  it("a cue that collides with an engine built-in keeps deepwatch's version", () => {
    // If these ever stop differing the explicit entries are redundant — but while
    // they differ, omitting one from CUES is an audible regression with no error.
    const collisions = Object.keys(CUES).filter((c) => c in DEFAULT_PATCHES);
    expect(collisions.sort()).toEqual(['beat', 'go', 'select']);
    for (const c of collisions) {
      expect(CUES[c as Cue], `${c} must be listed explicitly`).not.toEqual(DEFAULT_PATCHES[c]);
    }
    // The specific one most likely to be waved through: a different oscillator.
    expect(CUES.beat.type).toBe('sine');
    expect(DEFAULT_PATCHES.beat.type).toBe('triangle');
  });
});

describe('depth still pitches the surface cue', () => {
  it('rings at full pitch at the surface and ~0.38 at the floor', () => {
    expect(depthPitch(0, 10)).toBeCloseTo(1, 10);
    expect(depthPitch(10, 10)).toBeCloseTo(0.38, 10);
    expect(depthPitch(5, 10)).toBeCloseTo(0.69, 10);
  });

  it('descends monotonically — the whole point of the cue', () => {
    for (let d = 1; d <= 10; d++) expect(depthPitch(d, 10)).toBeLessThan(depthPitch(d - 1, 10));
  });

  it('clamps, because the engine IGNORES a pitch <= 0 instead of clamping it', () => {
    // Unclamped, a ratio > 1.61 yields a negative multiplier, which the engine
    // drops (`opts.pitch && opts.pitch > 0`) — playing at FULL pitch, the exact
    // opposite of a deep card. This is why the clamp lives in depthPitch.
    expect(depthPitch(100, 10)).toBeCloseTo(0.38, 10);
    expect(depthPitch(100, 10)).toBeGreaterThan(0);
    expect(depthPitch(-5, 10)).toBeCloseTo(1, 10);
    expect(depthPitch(3, 0)).toBeCloseTo(0.38, 10); // deckMax 0 must not divide by zero
    expect(Number.isFinite(depthPitch(3, 0))).toBe(true);
  });
});

describe('audio can never break a dive', () => {
  /** Install an AudioContext that throws on construction, as a hardened browser does. */
  const withBlockedAudio = (run: () => void): void => {
    const original = Object.getOwnPropertyDescriptor(window, 'AudioContext');
    const Blocked = vi.fn(() => {
      throw new DOMException('AudioContext blocked', 'NotAllowedError');
    });
    Object.defineProperty(window, 'AudioContext', { value: Blocked, configurable: true, writable: true });
    try {
      run();
      expect(Blocked).toHaveBeenCalled(); // the throw really was on the path
    } finally {
      if (original) Object.defineProperty(window, 'AudioContext', original);
      else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'AudioContext');
    }
  };

  it('unlock() swallows a blocked AudioContext', () => {
    withBlockedAudio(() => {
      const sfx = createGameSfx(false);
      expect(() => sfx.unlock()).not.toThrow();
    });
  });

  it('play() swallows a blocked AudioContext', () => {
    withBlockedAudio(() => {
      const sfx = createGameSfx(false);
      expect(() => sfx.play('surface', { pitch: depthPitch(4, 10) })).not.toThrow();
    });
  });

  it('a tap handler shaped like main.ts still reaches the move', () => {
    // main.ts: onTap: () => { sfx.unlock(); session?.play(); }
    // The regression this guards is not silence, it is an untappable game.
    withBlockedAudio(() => {
      const sfx = createGameSfx(false);
      let played = false;
      const onTap = (): void => {
        sfx.unlock();
        played = true;
      };
      expect(() => onTap()).not.toThrow();
      expect(played, 'the move must survive a blocked AudioContext').toBe(true);
    });
  });

  it('muting round-trips through the wrapper', () => {
    const sfx = createGameSfx(true);
    expect(sfx.muted()).toBe(true);
    sfx.setMuted(false);
    expect(sfx.muted()).toBe(false);
  });
});

describe('the fork is gone', () => {
  it('no local copy of the engine synth survives', () => {
    expect(() => readFileSync(join(ROOT, 'src/sound.ts'), 'utf8')).toThrow();
  });
});
