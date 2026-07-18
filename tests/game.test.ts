/**
 * game.test.ts — the rules of the dive.
 *
 * Several of these exist because the balance sim cannot reach the code they
 * cover: a competent crew never lets the tide top out, so the surge path — which
 * is also the game's termination guarantee — is driven directly here.
 */

import { describe, expect, it } from 'vitest';
import {
  cardsLeft,
  createDive,
  dealLevel,
  diverLeft,
  fireSonar,
  nextLevel,
  playCard,
  setHolding,
  shallowest,
  step,
  takeEvents,
  tanksFor,
  tideFrac,
  type DiveState,
} from '../src/game';
import { MODES, deckFor, levelsFor, maxCardsNeeded, modeOf, tideForLevel } from '../src/modes';
import { SONAR_HOLD_MS } from '../src/tuning';

const crew = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, name: `D${i}`, bot: false }));

const dive = (n = 3, modeId: 'shallows' | 'trench' | 'abyss' = 'trench', seed = 42): DiveState =>
  createDive({ modeId, seed, divers: crew(n) });

/** Force a known hand layout so a rule can be tested without hunting for a seed. */
function withHands(s: DiveState, hands: number[][]): DiveState {
  s.hands = hands.map((h) => h.slice().sort((a, b) => a - b));
  return s;
}

describe('dealing', () => {
  it('gives every diver `level` cards, all distinct across the table', () => {
    for (const level of [1, 3, 7]) {
      const hands = dealLevel(99, level, 4, 120);
      expect(hands).toHaveLength(4);
      for (const h of hands) expect(h).toHaveLength(level);
      const all = hands.flat();
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('hands each diver its cards in ascending order', () => {
    for (const h of dealLevel(7, 6, 3, 90)) {
      expect(h).toEqual([...h].sort((a, b) => a - b));
    }
  });

  it('is identical for the same (seed, level) — the whole P2P model rests on it', () => {
    expect(dealLevel(1234, 5, 3, 80)).toEqual(dealLevel(1234, 5, 3, 80));
  });

  it('differs between levels of the same dive', () => {
    expect(dealLevel(1234, 5, 3, 80)).not.toEqual(dealLevel(1234, 6, 3, 80));
  });

  it('refuses a deal it cannot make distinct rather than repeating a card', () => {
    expect(() => dealLevel(1, 10, 4, 30)).toThrow(/distinct/);
  });

  it('every mode can actually be dealt at every party size', () => {
    for (const mode of Object.values(MODES)) {
      for (const n of [2, 3, 4]) {
        expect(maxCardsNeeded(mode, n)).toBeLessThanOrEqual(deckFor(mode, n));
        expect(() =>
          dealLevel(1, levelsFor(mode, n), n, deckFor(mode, n)),
        ).not.toThrow();
      }
    }
  });
});

describe('surfacing a card', () => {
  it('puts it on the line and raises the floor', () => {
    const s = withHands(dive(2), [[10, 40], [25, 60]]);
    expect(playCard(s, 0)).toBe(true);
    expect(s.surfaced.map((c) => c.depth)).toEqual([10]);
    expect(s.floor).toBe(10);
    expect(s.stats[0].clean).toBe(1);
    expect(s.tanks).toBe(MODES.trench.tanks);
  });

  it('dredges up everything shallower and costs a tank', () => {
    const s = withHands(dive(2), [[40], [12, 25]]);
    const before = s.tanks;
    playCard(s, 0);
    expect(s.tanks).toBe(before - 1);
    expect(s.dredged.map((c) => c.depth).sort((a, b) => a - b)).toEqual([12, 25]);
    expect(s.stats[0].misplays).toBe(1);
    expect(s.stats[1].lost).toBe(2);
    expect(takeEvents(s).some((e) => e.t === 'misplay')).toBe(true);
  });

  it('is clean when nothing shallower is left anywhere', () => {
    const s = withHands(dive(3), [[5], [30], [70]]);
    playCard(s, 0);
    playCard(s, 1);
    expect(s.tanks).toBe(tanksFor(MODES.trench, 3));
    expect(s.stats.reduce((t, x) => t + x.misplays, 0)).toBe(0);
  });

  it('refuses to play from an empty hand', () => {
    const s = withHands(dive(2), [[], [10]]);
    expect(playCard(s, 0)).toBe(false);
  });

  it('ends the dive when the last tank goes', () => {
    const s = withHands(dive(2), [[90], [1, 2, 3]]);
    s.tanks = 1;
    playCard(s, 0);
    expect(s.phase).toBe('lost');
    expect(s.ending).toBe('tanks');
    expect(s.finalHands).not.toBeNull();
  });

  it('clears the level once every hand is empty', () => {
    const s = withHands(dive(2), [[5], [9]]);
    playCard(s, 0);
    playCard(s, 1);
    expect(s.phase).toBe('clear');
    expect(cardsLeft(s)).toBe(0);
  });
});

describe('sonar', () => {
  it('discards each diver s shallowest, face-up, and spends a charge', () => {
    const s = withHands(dive(3), [[5, 50], [12, 60], [40, 70]]);
    const pings = s.pings;
    expect(fireSonar(s)).toBe(true);
    expect(s.pings).toBe(pings - 1);
    expect(s.dredged.map((c) => c.depth).sort((a, b) => a - b)).toEqual([5, 12, 40]);
    expect(s.hands.map((h) => h.length)).toEqual([1, 1, 1]);
  });

  it('DOES NOT move the floor', () => {
    // The bug this pins: raising the floor to the deepest discard strands any
    // surviving card below it, so the line renders descending and every diver's
    // read of the table is poisoned. A discard never reaches the line.
    const s = withHands(dive(3), [[5, 20, 60], [40, 45], [41, 70]]);
    fireSonar(s);
    expect(s.floor).toBe(0);
    expect(s.hands[0]).toEqual([20, 60]);
    // …and the stranded 20 is still perfectly legal to play next.
    expect(playCard(s, 0)).toBe(true);
    expect(s.stats[0].misplays).toBe(0);
  });

  it('needs every diver who still holds cards', () => {
    const s = withHands(dive(3), [[5], [12], [40]]);
    setHolding(s, 0, true);
    setHolding(s, 1, true);
    step(s, SONAR_HOLD_MS + 50);
    expect(s.pings).toBe(MODES.trench.pings);
    setHolding(s, 2, true);
    step(s, SONAR_HOLD_MS + 50);
    expect(s.pings).toBe(MODES.trench.pings - 1);
  });

  it('ignores divers who are already out of cards', () => {
    const s = withHands(dive(3), [[5], [12], []]);
    setHolding(s, 0, true);
    setHolding(s, 1, true);
    step(s, SONAR_HOLD_MS + 50);
    expect(s.pings).toBe(MODES.trench.pings - 1);
  });

  it('resets the hold the moment anyone lets go', () => {
    const s = withHands(dive(2), [[5], [12]]);
    setHolding(s, 0, true);
    setHolding(s, 1, true);
    step(s, 300);
    expect(s.holdMs).toBeGreaterThan(0);
    setHolding(s, 1, false);
    step(s, 10);
    expect(s.holdMs).toBe(0);
  });

  it('cannot be spent without a charge', () => {
    const s = withHands(dive(2), [[5], [12]]);
    s.pings = 0;
    expect(fireSonar(s)).toBe(false);
  });
});

describe('the tide', () => {
  it('surges when it tops out: a tank, and the shallowest card dragged up', () => {
    const s = withHands(dive(2), [[8, 50], [30]]);
    const before = s.tanks;
    step(s, s.tideMs + 10);
    expect(s.tanks).toBe(before - 1);
    expect(s.surfaced[0]).toMatchObject({ depth: 8, forced: 'tide' });
    expect(s.tideMs).toBeGreaterThan(0);
  });

  it('does not punish the crew twice for the same card', () => {
    const s = withHands(dive(2), [[8], [30]]);
    step(s, s.tideMs + 10);
    expect(s.hands[0]).toEqual([]);
    expect(s.surfaced).toHaveLength(1);
  });

  it('GUARANTEES TERMINATION — a crew that never plays still ends', () => {
    // This is why the tide exists mechanically, quite apart from the pressure:
    // every surge costs a tank and tanks are finite, so there is no way to stall
    // the game forever. The balance sim can never reach this path, so it is
    // driven directly.
    const s = dive(4, 'abyss');
    for (let i = 0; i < 2000; i++) {
      if (s.phase === 'won' || s.phase === 'lost') break;
      // Surges can legitimately clear a whole level for a frozen crew, so the
      // level machine has to keep turning — otherwise this asserts nothing.
      if (s.phase === 'clear') nextLevel(s);
      else step(s, 5000);
    }
    expect(s.phase).toBe('lost');
    expect(s.tanks).toBe(0);
  });

  it('resolves a whole backlog when a tab returns from the background', () => {
    const s = dive(2);
    const huge = s.tideMaxMs * 12;
    step(s, huge);
    // It must not silently swallow the debt, and must not burn tanks it no
    // longer has once the dive is over.
    expect(s.tanks).toBeGreaterThanOrEqual(0);
    expect(s.phase === 'lost' || s.tideMs > 0).toBe(true);
  });

  it('reports a sane fraction throughout', () => {
    const s = dive(2);
    expect(tideFrac(s)).toBeCloseTo(1, 2);
    step(s, s.tideMaxMs / 2);
    expect(tideFrac(s)).toBeGreaterThan(0.4);
    expect(tideFrac(s)).toBeLessThan(0.6);
  });
});

describe('a diver leaving mid-level', () => {
  it('brings their cards up face-up and lets the level continue', () => {
    const s = withHands(dive(3), [[5], [12, 40], [70]]);
    diverLeft(s, 1);
    expect(s.hands[1]).toEqual([]);
    expect(s.dredged.map((c) => c.cause)).toEqual(['left', 'left']);
    expect(s.phase).toBe('diving');
    expect(s.floor).toBe(0);
  });

  it('keeps them in the roster so every peer s indices still line up', () => {
    const s = withHands(dive(3), [[5], [12], [70]]);
    diverLeft(s, 1);
    expect(s.divers).toHaveLength(3);
    expect(s.stats).toHaveLength(3);
  });

  it('clears the level if they were holding the last cards', () => {
    const s = withHands(dive(2), [[], [12, 40]]);
    diverLeft(s, 1);
    expect(s.phase).toBe('clear');
  });
});

describe('levels', () => {
  it('deals one more card each and tightens the tide', () => {
    const s = withHands(dive(3), [[1], [2], [3]]);
    playCard(s, 0);
    playCard(s, 1);
    playCard(s, 2);
    expect(s.phase).toBe('clear');
    const tide1 = s.tideMaxMs;
    nextLevel(s);
    expect(s.level).toBe(2);
    expect(s.hands.every((h) => h.length === 2)).toBe(true);
    expect(s.surfaced).toEqual([]);
    expect(s.floor).toBe(0);
    // More cards, so a longer clock overall, but LESS time per card.
    expect(s.tideMaxMs / (2 * 3)).toBeLessThan(tide1 / (1 * 3));
  });

  it('awards the bonus air and sonar the mode promises', () => {
    const s = dive(2, 'trench');
    const mode = MODES.trench;
    while (s.level < 4) {
      s.phase = 'clear';
      nextLevel(s);
    }
    expect(mode.tankAt).toContain(4);
    expect(s.tanks).toBe(tanksFor(mode, 2) + 1);
  });

  it('wins the dive on the last level', () => {
    const s = dive(2, 'shallows');
    s.level = s.levels;
    s.hands = [[1], [2]];
    playCard(s, 0);
    playCard(s, 1);
    expect(s.phase).toBe('won');
    expect(s.ending).toBe('surfaced');
  });

  it('only advances from a cleared level', () => {
    const s = dive(2);
    const level = s.level;
    nextLevel(s);
    expect(s.level).toBe(level);
  });
});

describe('helpers', () => {
  it('finds the shallowest card on the table', () => {
    const s = withHands(dive(3), [[40], [7, 90], [12]]);
    expect(shallowest(s)).toEqual({ depth: 7, by: 1 });
  });

  it('returns null when the table is empty', () => {
    const s = withHands(dive(2), [[], []]);
    expect(shallowest(s)).toBeNull();
  });

  it('scales the tide with the cards actually in the level', () => {
    const mode = MODES.trench;
    expect(tideForLevel(mode, 1, 4)).toBeGreaterThan(tideForLevel(mode, 1, 2));
    expect(tideForLevel(mode, 5, 2)).toBeGreaterThan(tideForLevel(mode, 1, 2));
  });

  it('falls back safely for a mode id that never existed', () => {
    // 'constructor' is truthy on every object, so a plain lookup would hand back
    // a function and the generator would read undefined for every field.
    for (const bad of ['constructor', 'toString', '__proto__', 'nope', 42, null, undefined]) {
      expect(modeOf(bad).id).toBe('trench');
    }
  });
});
