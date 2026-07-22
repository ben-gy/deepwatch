// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * sim.ts — run a whole dive headless, with an all-bot crew.
 *
 * This exists so tests/balance.test.ts can referee the difficulty curve instead
 * of me arguing about it (principle #18). It drives the REAL core in game.ts
 * through the REAL bot in bot.ts; nothing here reimplements a rule, because a
 * sim that reimplements the game measures the sim.
 *
 * One modelling decision worth naming: at most one card resolves per tick, and
 * the diver who gets it rotates with the tick counter. Two divers releasing in
 * the same 25ms really is a race, and rotating the winner keeps that race from
 * silently belonging to seat 0 forever.
 */

import { createBot, type BotOpts } from './bot';
import {
  createDive,
  dealLevel,
  nextLevel,
  playCard,
  setHolding,
  step,
  takeEvents,
  type DiveState,
  type Diver,
} from './game';
import type { ModeId } from './modes';

export interface SimOpts {
  modeId: ModeId;
  seed: number;
  divers: number;
  /** Set false to measure what the crew does with no sonar at all. */
  sonar?: boolean;
  tickMs?: number;
  /** Safety net; a run that hits this is a bug, not a hard dive. */
  maxSteps?: number;
  bot?: BotOpts;
  /** Sweep-only: add to the starting tanks to test party scaling. */
  tanksBonus?: number;
  /** Sweep-only: widen the deck by this factor and re-deal. */
  deckMul?: number;
}

export interface SimResult {
  /** Deepest level the crew fully cleared. 0 if they never cleared level 1. */
  cleared: number;
  /** The level they were on when it ended. */
  reached: number;
  won: boolean;
  tanksLeft: number;
  misplays: number;
  tideSurges: number;
  sonarsFired: number;
  steps: number;
  /** True if maxSteps was hit — the run failed to terminate. */
  stalled: boolean;
}

const crew = (n: number): Diver[] =>
  Array.from({ length: n }, (_, i) => ({ id: `b${i}`, name: `Diver ${i + 1}`, bot: true }));

export function simulateDive(opts: SimOpts): SimResult {
  const tickMs = opts.tickMs ?? 25;
  const maxSteps = opts.maxSteps ?? 200_000;
  const n = opts.divers;

  const s: DiveState = createDive({ modeId: opts.modeId, seed: opts.seed, divers: crew(n) });
  if (opts.sonar === false) s.pings = 0;
  if (opts.tanksBonus) {
    s.tanks += opts.tanksBonus;
    s.tanksMax = Math.max(s.tanksMax, s.tanks);
  }
  if (opts.deckMul && opts.deckMul !== 1) {
    s.deckMax = Math.ceil(s.deckMax * opts.deckMul);
    s.hands = dealLevel(opts.seed, 1, n, s.deckMax);
  }
  const bots = Array.from({ length: n }, (_, i) => createBot(i, opts.seed, opts.bot));

  let misplays = 0;
  let tideSurges = 0;
  let sonarsFired = 0;
  let cleared = 0;
  let steps = 0;

  // A closure, so TypeScript re-reads the declared phase type rather than
  // narrowing it from the loop condition — playCard and step mutate it, which
  // control-flow analysis cannot see through.
  const finished = (): boolean => s.phase === 'won' || s.phase === 'lost';

  const drain = (): void => {
    for (const e of takeEvents(s)) {
      if (e.t === 'misplay') misplays++;
      else if (e.t === 'tide') tideSurges++;
      else if (e.t === 'sonar') sonarsFired++;
      else if (e.t === 'clear') cleared = e.level;
    }
  };

  while (!finished()) {
    if (steps++ >= maxSteps) {
      return {
        cleared,
        reached: s.level,
        won: false,
        tanksLeft: s.tanks,
        misplays,
        tideSurges,
        sonarsFired,
        steps,
        stalled: true,
      };
    }

    if (s.phase === 'clear') {
      nextLevel(s);
      // Modes hand out bonus charges at pingAt levels, so zeroing pings once at
      // the start is NOT a sonar-free control — the crew quietly gets sonar back
      // from level 6 and the comparison measures nothing. This kept the arm
      // honest and turned a "sonar does not help" result into "it does".
      if (opts.sonar === false) s.pings = 0;
      continue;
    }

    const wants: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const a = bots[i].decide(s, tickMs);
      wants.push(a.play);
      setHolding(s, i, a.signal);
    }

    const start = steps % n;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (wants[i] && s.hands[i].length) {
        playCard(s, i);
        break;
      }
    }
    drain();
    if (finished()) break;

    step(s, tickMs);
    drain();
  }
  drain();

  return {
    cleared,
    reached: s.level,
    won: s.phase === 'won',
    tanksLeft: s.tanks,
    misplays,
    tideSurges,
    sonarsFired,
    steps,
    stalled: false,
  };
}

export interface Curve {
  runs: number;
  /** P(the crew cleared level N), indexed from 1. */
  clearRate: number[];
  finishRate: number;
  medianTanksLeft: number;
  medianCleared: number;
  meanMisplays: number;
  meanSurges: number;
  meanSonars: number;
  stalls: number;
}

/** Run a fixed-seed batch and reduce it to the shape the assertions care about. */
export function curveFor(opts: Omit<SimOpts, 'seed'> & { runs: number; levels: number }): Curve {
  const results: SimResult[] = [];
  for (let i = 0; i < opts.runs; i++) {
    results.push(simulateDive({ ...opts, seed: 0x51ed_0000 + i }));
  }
  const clearRate: number[] = [0];
  for (let lv = 1; lv <= opts.levels; lv++) {
    clearRate.push(results.filter((r) => r.cleared >= lv).length / results.length);
  }
  const median = (xs: number[]): number => {
    const a = xs.slice().sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)];
  };
  const mean = (xs: number[]): number => xs.reduce((t, x) => t + x, 0) / xs.length;

  return {
    runs: results.length,
    clearRate,
    finishRate: results.filter((r) => r.won).length / results.length,
    medianTanksLeft: median(results.map((r) => r.tanksLeft)),
    medianCleared: median(results.map((r) => r.cleared)),
    meanMisplays: mean(results.map((r) => r.misplays)),
    meanSurges: mean(results.map((r) => r.tideSurges)),
    meanSonars: mean(results.map((r) => r.sonarsFired)),
    stalls: results.filter((r) => r.stalled).length,
  };
}
