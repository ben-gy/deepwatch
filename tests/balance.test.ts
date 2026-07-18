/**
 * balance.test.ts — the difficulty curve is the opponent, so it gets measured.
 *
 * Deepwatch is co-op, so there is no seat to be unfair and no leader to snowball.
 * What there IS is a ramp, and a ramp is exactly as easy to get catastrophically
 * wrong as a versus game's balance — and just as invisible to unit tests and to
 * the two minutes you spend playing it yourself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE SIM OVERRULED. Every one of these was a confident diagnosis that the
 * numbers killed, which is the whole reason the sim is written before the tuning.
 *
 *  1. The rising tide never fired. Not once, in any mode, in any run — the
 *     headline mechanic was decoration. (It is still the termination guarantee
 *     and a real threat to a human who freezes; tests/game.test.ts drives the
 *     surge path directly, because the sim will not reach it.)
 *  2. Sonar was WORSE THAN NOT HAVING IT: 7% finishes with it against 8%
 *     without. Two rewrites of the trigger were needed. The one that works
 *     signals on DANGER and lets the unanimity requirement do the detecting.
 *  3. Patience below the hold time is a silent disaster: at 400ms against a
 *     700ms hold the crew pays the full hesitation cost and can never reach the
 *     ping — 1% against 37% for having no sonar at all. Pinned below.
 *  4. Widening the deck to compensate for party size did NOTHING (1x to 2.8x
 *     moved four-diver Trench from 15% to 8%, i.e. noise). Purely proportional
 *     jitter makes every absolute scale cancel; the fix was a flat jitter term.
 *  5. Scaling air tanks with the party did not rescue big crews either — at +3
 *     tanks per extra diver a four-diver Abyss still finished 0%.
 *
 * What finally worked was structural and simple: a tide budget PER CARD rather
 * than per level, and a dive whose DEPTH scales down as the crew grows so every
 * party size faces the same total number of cards. Only after that did the tank
 * bonus start earning anything.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, it } from 'vitest';
import { curveFor, simulateDive } from '../src/sim';
import { MODES, MODE_IDS, levelsFor, tideForLevel, type ModeId } from '../src/modes';
import { JITTER, JITTER_MS, JOIN_K, SONAR_HOLD_MS, SONAR_PATIENCE_MS, TENSION_K } from '../src/tuning';

const RUNS = 150;
const PARTIES = [2, 3, 4] as const;

const curve = (modeId: ModeId, divers: number, sonar = true) =>
  curveFor({ modeId, divers, runs: RUNS, levels: levelsFor(MODES[modeId], divers), sonar });

/** Every (mode, party) pair, measured once and shared by the assertions below. */
const MEASURED = MODE_IDS.flatMap((id) =>
  PARTIES.map((divers) => ({ id, divers, c: curve(id, divers) })),
);

describe('the ramp has the right shape', () => {
  it('never gets easier as it gets deeper', () => {
    for (const { id, divers, c } of MEASURED) {
      const rates = c.clearRate.slice(1);
      for (let i = 1; i < rates.length; i++) {
        expect(rates[i], `${id} n=${divers} level ${i + 1} easier than ${i}`).toBeLessThanOrEqual(
          rates[i - 1] + 0.02,
        );
      }
    }
  });

  it('opens as an on-ramp rather than a coin flip', () => {
    for (const { id, divers, c } of MEASURED) {
      expect(c.clearRate[1], `${id} n=${divers} level 1`).toBeGreaterThan(0.95);
      expect(c.clearRate[2], `${id} n=${divers} level 2`).toBeGreaterThan(0.9);
    }
  });

  it('has no cliff — no single level halves the crew', () => {
    for (const { id, divers, c } of MEASURED) {
      const rates = c.clearRate.slice(1);
      for (let i = 1; i < rates.length; i++) {
        const drop = rates[i - 1] - rates[i];
        expect(drop, `${id} n=${divers} cliff into level ${i + 1}`).toBeLessThan(0.35);
      }
    }
  });

  it('ends somewhere real — the last level is neither a wall nor a formality', () => {
    for (const { id, divers, c } of MEASURED) {
      expect(c.finishRate, `${id} n=${divers} is a wall`).toBeGreaterThan(0.15);
      // Shallows is the on-ramp and is allowed to be clearable by a competent
      // crew; the other two must be able to end a run.
      if (id !== 'shallows') {
        expect(c.finishRate, `${id} n=${divers} is a formality`).toBeLessThan(0.95);
      }
    }
  });
});

describe('every party size is playable', () => {
  it('two, three and four divers all clear each mode a reasonable share of the time', () => {
    for (const { id, divers, c } of MEASURED) {
      expect(c.finishRate, `${id} n=${divers}`).toBeGreaterThan(0.15);
    }
  });

  it('keeps the total cards a crew must get right roughly constant across parties', () => {
    // This is THE fix for the party-size collapse, so it is asserted directly
    // rather than left to emerge. A bigger crew dives fewer levels.
    for (const id of MODE_IDS) {
      const totals = PARTIES.map((n) => {
        const levels = levelsFor(MODES[id], n);
        return (n * levels * (levels + 1)) / 2;
      });
      const lo = Math.min(...totals);
      const hi = Math.max(...totals);
      expect(hi / lo, `${id} card totals ${totals.join('/')}`).toBeLessThan(1.3);
    }
  });

  it('quotes the mode table at two divers', () => {
    for (const id of MODE_IDS) expect(levelsFor(MODES[id], 2)).toBe(MODES[id].levels);
  });

  it('dives shallower as the crew grows', () => {
    for (const id of MODE_IDS) {
      expect(levelsFor(MODES[id], 4)).toBeLessThan(levelsFor(MODES[id], 2));
    }
  });
});

describe('the modes are ordered, and are actually different', () => {
  const avg = (id: ModeId): number =>
    MEASURED.filter((m) => m.id === id).reduce((t, m) => t + m.c.finishRate, 0) / PARTIES.length;

  it('Shallows is kinder than Trench, which is kinder than Abyss', () => {
    expect(avg('shallows')).toBeGreaterThan(avg('trench'));
    expect(avg('trench')).toBeGreaterThan(avg('abyss'));
  });

  it('separates them by enough to be worth choosing between', () => {
    expect(avg('shallows') - avg('abyss')).toBeGreaterThan(0.25);
  });
});

describe('sonar earns its slot', () => {
  /**
   * Measured PAIRED — same seed, sonar on and off, compare how deep the crew
   * got. Comparing two independent finish-rate averages is far too noisy to see
   * an effect this size, and chasing that noise is how two earlier wrong
   * conclusions got made here.
   *
   * Note the control arm has to KEEP sonar off. Zeroing pings once at the start
   * is not enough: modes hand out bonus charges at pingAt levels, so the "no
   * sonar" crew quietly got sonar back from level 6 and the comparison measured
   * nothing at all. sim.ts re-zeroes on every level for exactly this reason.
   */
  function paired(modeId: ModeId, divers: number, seeds = 400) {
    let deeper = 0;
    let shallower = 0;
    for (let i = 0; i < seeds; i++) {
      const seed = 0x7a11_0000 + i;
      const on = simulateDive({ modeId, seed, divers });
      const off = simulateDive({ modeId, seed, divers, sonar: false });
      if (on.cleared > off.cleared) deeper++;
      else if (on.cleared < off.cleared) shallower++;
    }
    return { deeper, shallower };
  }

  it('takes the crew DEEPER more often than not', () => {
    // Across all nine mode/party combinations at 700 seeds each this reads
    // 1091 deeper against 855 shallower — a +5.35 sigma effect. Trench, where a
    // charge is most often the difference, carries most of it.
    const r = paired('trench', 3);
    expect(r.deeper).toBeGreaterThan(r.shallower);
  });

  it('helps in Abyss too, where there is only one charge to spend', () => {
    const r = paired('abyss', 2, 300);
    expect(r.deeper).toBeGreaterThan(r.shallower * 0.9);
  });

  it('actually gets spent', () => {
    for (const { id, divers, c } of MEASURED) {
      expect(c.meanSonars, `${id} n=${divers} never pings`).toBeGreaterThan(0.5);
    }
  });

  it('is worthless unless divers read each other', () => {
    // The mechanic only pays when a diver JOINS a signal someone else started.
    // With every diver deciding alone it measured as neutral-to-negative,
    // because a signal that never reaches consensus is a shared stall that
    // costs tide and buys nothing. That is a pleasing thing to have had to
    // discover, given the game is about reading people, but it is also a real
    // dependency — so it is pinned.
    expect(JOIN_K).toBeGreaterThan(1);
  });
});

describe('runs end, and end tensely', () => {
  it('never stalls', () => {
    for (const { id, divers, c } of MEASURED) {
      expect(c.stalls, `${id} n=${divers} failed to terminate`).toBe(0);
    }
  });

  it('spends air — a dive that never costs a tank has no tension', () => {
    for (const { id, divers, c } of MEASURED) {
      expect(c.meanMisplays, `${id} n=${divers} is frictionless`).toBeGreaterThan(0.5);
    }
  });

  it('terminates even when the crew simply never plays', () => {
    // The tide is the termination guarantee: every surge costs a tank and tanks
    // are finite, so a frozen table still reaches `lost` in bounded time.
    const r = simulateDive({ modeId: 'abyss', seed: 7, divers: 4, tickMs: 250, maxSteps: 20_000 });
    expect(r.stalled).toBe(false);
  });
});

describe('the dive is paced for a human, not for the simulator', () => {
  it('gives level 1 enough seconds to actually read the gauge', () => {
    // The bug this pins is one the sim structurally cannot see: its divers judge
    // instantly, so it happily certified a Trench level 1 that ran in 6.3s. In a
    // real browser a person got zero taps in before the tide surfaced their
    // cards for them. A first level needs time to look, judge and commit.
    for (const id of MODE_IDS) {
      for (const divers of PARTIES) {
        const ms = tideForLevel(MODES[id], 1, divers);
        expect(ms, `${id} n=${divers} level 1 is too fast to play`).toBeGreaterThan(8000);
      }
    }
  });

  it('keeps a whole dive inside a sitting', () => {
    for (const id of MODE_IDS) {
      for (const divers of PARTIES) {
        let total = 0;
        for (let lv = 1; lv <= levelsFor(MODES[id], divers); lv++) {
          total += tideForLevel(MODES[id], lv, divers);
        }
        expect(total / 60000, `${id} n=${divers} dive length`).toBeLessThan(10);
      }
    }
  });
});

describe('the constants the curve hangs on', () => {
  it('pins the jitter split — proportional AND flat', () => {
    // With JITTER_MS at 0 the game becomes untunable: every absolute scale
    // cancels out of the misorder condition and no amount of deck, tide or tank
    // design moves the curve. See tuning.ts.
    expect(JITTER).toBeCloseTo(0.44, 5);
    expect(JITTER_MS).toBe(900);
    expect(JITTER_MS).toBeGreaterThan(0);
  });

  it('pins TENSION_K, which is what makes silence mean anything', () => {
    expect(TENSION_K).toBeCloseTo(1.35, 5);
  });

  it('KEEPS SONAR PATIENCE ABOVE THE HOLD TIME', () => {
    // The failure is silent and total: below the hold, the crew hesitates for
    // exactly long enough to lose the tide and never reaches a ping. 1% vs 37%.
    expect(SONAR_PATIENCE_MS).toBeGreaterThan(SONAR_HOLD_MS);
  });
});
