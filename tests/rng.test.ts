/**
 * rng.test.ts — the P2P-sync determinism invariant.
 *
 * Deepwatch leans on this harder than most games in this factory: hands are
 * never sent over the wire at all, only derived from the seed. If two peers ever
 * disagreed about a deal they would be adjudicating different tables while both
 * believing the other had misplayed.
 */

import { describe, expect, it } from 'vitest';
import { hashSeed, makeRng, pick, randInt, shuffle } from '../src/engine/rng';
import { dealLevel } from '../src/game';
import { MODES, deckFor, levelsFor } from '../src/modes';

describe('makeRng', () => {
  it('gives an identical stream for an identical seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    expect(Array.from({ length: 50 }, a)).toEqual(Array.from({ length: 50 }, b));
  });

  it('diverges for different seeds', () => {
    const a = Array.from({ length: 20 }, makeRng(1));
    const b = Array.from({ length: 20 }, makeRng(2));
    expect(a).not.toEqual(b);
  });

  it('stays inside [0, 1)', () => {
    const rng = makeRng('deepwatch');
    for (let i = 0; i < 5000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('accepts a string seed and hashes it stably', () => {
    expect(hashSeed('room-K7QP')).toBe(hashSeed('room-K7QP'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});

describe('shuffle / randInt / pick', () => {
  it('shuffles identically from the same seed and keeps every element', () => {
    const src = Array.from({ length: 60 }, (_, i) => i);
    const a = shuffle(makeRng(7), src);
    const b = shuffle(makeRng(7), src);
    expect(a).toEqual(b);
    expect(a.slice().sort((p, q) => p - q)).toEqual(src);
    expect(src[0]).toBe(0); // input untouched
  });

  it('keeps randInt within bounds, inclusive', () => {
    const rng = makeRng(3);
    for (let i = 0; i < 2000; i++) {
      const v = randInt(rng, 5, 9);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(9);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('picks deterministically', () => {
    const arr = ['a', 'b', 'c', 'd'];
    expect(pick(makeRng(11), arr)).toBe(pick(makeRng(11), arr));
  });
});

describe('two peers deal the same table', () => {
  it('produces byte-identical hands for every mode and party size', () => {
    for (const mode of Object.values(MODES)) {
      for (const divers of [2, 3, 4]) {
        const deck = deckFor(mode, divers);
        for (let level = 1; level <= levelsFor(mode, divers); level++) {
          const peerA = dealLevel(0xbeef, level, divers, deck);
          const peerB = dealLevel(0xbeef, level, divers, deck);
          expect(peerB, `${mode.id} n=${divers} level ${level}`).toEqual(peerA);
        }
      }
    }
  });

  it('does not repeat a level s deal in the next level', () => {
    const seen = new Set<string>();
    for (let level = 1; level <= 10; level++) {
      seen.add(JSON.stringify(dealLevel(5, level, 3, 120)));
    }
    expect(seen.size).toBe(10);
  });

  it('gives different rooms different tables', () => {
    expect(dealLevel(1, 4, 3, 90)).not.toEqual(dealLevel(2, 4, 3, 90));
  });
});
