/**
 * game.ts — the dive itself. Pure, tick-driven, and free of the DOM, the clock
 * and the network, so the identical code runs the real game at 60fps and a few
 * thousand headless AI dives inside tests/balance.test.ts.
 *
 * The rules, complete:
 *  - Every diver holds `level` creature cards, all depths distinct within a
 *    level, drawn deterministically from the round seed.
 *  - Cards must be surfaced onto one shared line in ASCENDING depth.
 *  - Surface a card while anything shallower is still in someone's hand and that
 *    is a MISPLAY: every shallower card is dredged up face-up and the crew burns
 *    one shared air tank.
 *  - The tide runs down all level. When it tops out the crew burns a tank and
 *    the shallowest card in play is dragged up for them.
 *  - Holding together spends a sonar charge: every diver discards their single
 *    shallowest card, face-up.
 *  - Empty every hand to clear the level. Clear the last level to surface.
 *    Reach zero tanks and the dive is over.
 *
 * WHY THE TIDE GUARANTEES TERMINATION: a surge always costs a tank and always
 * removes a card, and tanks are finite and bounded above by the mode's start
 * plus its bonuses. So a crew that simply never plays still reaches `lost` in a
 * bounded number of surges — there is no way to stall the sim forever. This is
 * asserted directly in tests/game.test.ts rather than left as an argument.
 */

import { makeRng, shuffle } from './engine/rng';
import { deckFor, levelsFor, modeOf, tideForLevel, type Mode, type ModeId } from './modes';
import { SONAR_HOLD_MS, TIDE_REFUND } from './tuning';

export type Phase = 'diving' | 'clear' | 'won' | 'lost';

export interface Diver {
  id: string;
  name: string;
  bot: boolean;
}

/** A card that made it onto the line. */
export interface Surfaced {
  depth: number;
  /** Index into `divers`. */
  by: number;
  /** Absent for a normal play. */
  forced?: 'tide';
}

/** A card that was lost face-up rather than played. */
export interface Dredged {
  depth: number;
  by: number;
  cause: 'misplay' | 'sonar' | 'left';
}

export interface DiverStats {
  /** Cards this diver put on the line. */
  surfaced: number;
  /** …of those, how many were in order. */
  clean: number;
  /** Misplays this diver caused. */
  misplays: number;
  /** Cards of theirs dredged up (by anyone's mistake, sonar, or leaving). */
  lost: number;
}

export type DiveEvent =
  | { t: 'surface'; depth: number; by: number; deckMax: number }
  | { t: 'misplay'; by: number; lost: Dredged[] }
  | { t: 'tide'; depth: number | null }
  | { t: 'sonar'; lost: Dredged[] }
  | { t: 'clear'; level: number }
  | { t: 'won' }
  | { t: 'lost' };

export interface DiveState {
  modeId: ModeId;
  seed: number;
  divers: Diver[];
  /** Depth of this dive's deck — derived from the mode's density and party size. */
  deckMax: number;
  /** How deep this dive goes — derived from the mode and party size. */
  levels: number;
  level: number;
  /** Per diver, ascending. The one thing never broadcast to other peers. */
  hands: number[][];
  surfaced: Surfaced[];
  dredged: Dredged[];
  /** Deepest card surfaced so far this level. 0 before the first. */
  floor: number;
  tanks: number;
  /** Highest tank count this dive has held — the results screen shows the ratio. */
  tanksMax: number;
  pings: number;
  tideMs: number;
  tideMaxMs: number;
  /** Per diver: currently signalling for sonar. */
  holding: boolean[];
  /** How long the WHOLE crew has been holding together. */
  holdMs: number;
  phase: Phase;
  /** Since the floor last moved — this is the clock every diver reads. */
  sinceFloorMs: number;
  elapsedMs: number;
  stats: DiverStats[];
  /** Drained by the renderer / sound each frame. */
  events: DiveEvent[];
  /** Set when the run ends, for the results screen. */
  ending: 'tanks' | 'surfaced' | null;
  /** Hands as they stood when the run ended — "what nobody could see". */
  finalHands: number[][] | null;
}

export interface DiveOpts {
  modeId: ModeId;
  seed: number;
  divers: Diver[];
}

const LEVEL_SALT = 0x9e3779b1;

/**
 * Deal one level. Deterministic from (seed, level) alone, so every peer — and a
 * peer promoted to host halfway through — derives byte-identical hands without
 * anything crossing the wire.
 */
export function dealLevel(seed: number, level: number, divers: number, deckMax: number): number[][] {
  const need = level * divers;
  if (need > deckMax) {
    throw new Error(`deal: level ${level} x ${divers} divers needs ${need} distinct cards of ${deckMax}`);
  }
  const rng = makeRng((seed >>> 0) ^ Math.imul(level, LEVEL_SALT));
  const deck = shuffle(
    rng,
    Array.from({ length: deckMax }, (_, i) => i + 1),
  );
  const hands: number[][] = [];
  for (let d = 0; d < divers; d++) {
    hands.push(deck.slice(d * level, d * level + level).sort((a, b) => a - b));
  }
  return hands;
}

const freshStats = (): DiverStats => ({ surfaced: 0, clean: 0, misplays: 0, lost: 0 });

/**
 * Air tanks for a crew of this size: one more per diver past two.
 *
 * Both halves of this are sim results, and the ORDER matters. On its own, tank
 * scaling does not rescue a big crew at all — at +3 tanks per extra diver a
 * four-diver Abyss still finished 0% of runs, because the real problem was that
 * its last level dealt 48 cards against a two-diver level's 24. Scaling the DIVE
 * (levelsFor) is what fixed that. Only once every party faced the same total
 * number of cards did the tank bonus start doing useful work, and then it was
 * worth a lot: four-diver Trench 28% flat against 69% at +1, Abyss 20% against
 * 60%. A modest bonus for the extra hidden hands, on top of a dive sized for the
 * crew.
 *
 * Two divers is the baseline the mode table quotes.
 */
export function tanksFor(mode: Mode, divers: number): number {
  return mode.tanks + Math.max(0, divers - 2);
}

export function createDive(opts: DiveOpts): DiveState {
  const mode = modeOf(opts.modeId);
  const n = opts.divers.length;
  const tide = tideForLevel(mode, 1, n);
  const tanks = tanksFor(mode, n);
  const deckMax = deckFor(mode, n);
  return {
    modeId: mode.id,
    seed: opts.seed >>> 0,
    divers: opts.divers.slice(),
    deckMax,
    levels: levelsFor(mode, n),
    level: 1,
    hands: dealLevel(opts.seed, 1, n, deckMax),
    surfaced: [],
    dredged: [],
    floor: 0,
    tanks,
    tanksMax: tanks,
    pings: mode.pings,
    tideMs: tide,
    tideMaxMs: tide,
    holding: new Array(n).fill(false),
    holdMs: 0,
    phase: 'diving',
    sinceFloorMs: 0,
    elapsedMs: 0,
    stats: Array.from({ length: n }, freshStats),
    events: [],
    ending: null,
    finalHands: null,
  };
}

export const modeOfState = (s: DiveState): Mode => modeOf(s.modeId);

/** Cards still held, across the whole crew. */
export const cardsLeft = (s: DiveState): number => s.hands.reduce((n, h) => n + h.length, 0);

/** The shallowest card anyone is still holding, or null. */
export function shallowest(s: DiveState): { depth: number; by: number } | null {
  let best: { depth: number; by: number } | null = null;
  for (let i = 0; i < s.hands.length; i++) {
    const h = s.hands[i];
    if (h.length && (best === null || h[0] < best.depth)) best = { depth: h[0], by: i };
  }
  return best;
}

function burnTank(s: DiveState): void {
  s.tanks--;
  if (s.tanks <= 0) {
    s.tanks = 0;
    s.phase = 'lost';
    s.ending = 'tanks';
    s.finalHands = s.hands.map((h) => h.slice());
    s.events.push({ t: 'lost' });
  }
}

function afterRemoval(s: DiveState): void {
  if (s.phase !== 'diving') return;
  if (cardsLeft(s) > 0) return;
  s.events.push({ t: 'clear', level: s.level });
  if (s.level >= s.levels) {
    s.phase = 'won';
    s.ending = 'surfaced';
    s.finalHands = s.hands.map((h) => h.slice());
    s.events.push({ t: 'won' });
  } else {
    s.phase = 'clear';
  }
}

/**
 * Surface diver `i`'s shallowest card. The only move in the game.
 *
 * Everything shallower still held anywhere is unreachable the moment this lands,
 * so it comes up face-up and the crew pays a tank. That is the whole risk model.
 */
export function playCard(s: DiveState, i: number): boolean {
  if (s.phase !== 'diving') return false;
  const hand = s.hands[i];
  if (!hand || !hand.length) return false;

  const depth = hand.shift()!;
  const missed: Dredged[] = [];
  for (let d = 0; d < s.hands.length; d++) {
    while (s.hands[d].length && s.hands[d][0] < depth) {
      missed.push({ depth: s.hands[d].shift()!, by: d, cause: 'misplay' });
      s.stats[d].lost++;
    }
  }

  s.surfaced.push({ depth, by: i });
  s.floor = depth;
  s.sinceFloorMs = 0;
  s.stats[i].surfaced++;

  if (missed.length) {
    s.stats[i].misplays++;
    s.dredged.push(...missed);
    s.events.push({ t: 'misplay', by: i, lost: missed });
    burnTank(s);
  } else {
    s.stats[i].clean++;
    s.events.push({ t: 'surface', depth, by: i, deckMax: s.deckMax });
  }

  afterRemoval(s);
  return true;
}

/** Spend a sonar charge: every diver still holding cards discards their shallowest. */
export function fireSonar(s: DiveState): boolean {
  if (s.phase !== 'diving' || s.pings <= 0) return false;
  const lost: Dredged[] = [];
  for (let i = 0; i < s.hands.length; i++) {
    if (!s.hands[i].length) continue;
    const depth = s.hands[i].shift()!;
    lost.push({ depth, by: i, cause: 'sonar' });
    s.stats[i].lost++;
  }
  if (!lost.length) return false;
  s.pings--;
  s.holdMs = 0;
  s.holding.fill(false);
  s.dredged.push(...lost);
  // The floor deliberately does NOT move. It is the deepest card SURFACED, and
  // a discard never reaches the line. Raising it to the deepest discard looks
  // right and is badly wrong: each diver discards their own shallowest, which
  // says nothing about anyone else's second card. A crew holding [5,20,60],
  // [40,45] and [41,70] discards 5/40/41 — and a floor of 41 strands the
  // surviving 20 *below* the line, so it renders as a descending sequence and
  // every diver's read of the table is poisoned. Found by the balance sim, which
  // measured sonar as worse than not having it (33% against 37%).
  s.events.push({ t: 'sonar', lost });
  afterRemoval(s);
  return true;
}

/** The tide topped out: a tank, and the shallowest card is dragged up for you. */
function tideSurge(s: DiveState): void {
  const next = shallowest(s);
  if (next) {
    s.hands[next.by].shift();
    s.surfaced.push({ depth: next.depth, by: next.by, forced: 'tide' });
    s.floor = next.depth;
    s.stats[next.by].surfaced++;
  }
  s.sinceFloorMs = 0;
  s.tideMs = Math.round(s.tideMaxMs * TIDE_REFUND);
  s.events.push({ t: 'tide', depth: next?.depth ?? null });
  burnTank(s);
  afterRemoval(s);
}

/** Set a diver's sonar signal. The ping needs all of them at once. */
export function setHolding(s: DiveState, i: number, on: boolean): void {
  if (s.holding[i] === on) return;
  s.holding[i] = on;
  if (!on) s.holdMs = 0;
}

/** True while every diver who still holds cards is signalling. */
export function crewHolding(s: DiveState): boolean {
  const active = s.hands.map((h, i) => (h.length ? i : -1)).filter((i) => i >= 0);
  return active.length > 0 && active.every((i) => s.holding[i]);
}

/** Advance the dive by `dtMs`. Safe to call with a large dt (a tab returning). */
export function step(s: DiveState, dtMs: number): void {
  if (s.phase !== 'diving' || dtMs <= 0) return;
  s.elapsedMs += dtMs;
  s.sinceFloorMs += dtMs;

  if (s.pings > 0 && crewHolding(s)) {
    s.holdMs += dtMs;
    if (s.holdMs >= SONAR_HOLD_MS) fireSonar(s);
  } else {
    s.holdMs = 0;
  }
  if (s.phase !== 'diving') return;

  s.tideMs -= dtMs;
  // A long dt (a backgrounded tab, a slow sim tick) can bank several surges.
  // Resolve them all rather than swallowing the debt, but stop the moment the
  // dive ends, so a returning tab cannot burn tanks it no longer has.
  while (s.tideMs <= 0 && s.phase === 'diving') tideSurge(s);
}

/** Deal the next level after a `clear`. Separate so the UI can run a countdown. */
export function nextLevel(s: DiveState): void {
  if (s.phase !== 'clear') return;
  const mode = modeOfState(s);
  s.level++;
  s.hands = dealLevel(s.seed, s.level, s.divers.length, s.deckMax);
  s.surfaced = [];
  s.dredged = [];
  s.floor = 0;
  s.sinceFloorMs = 0;
  s.holdMs = 0;
  s.holding.fill(false);
  if (mode.tankAt.includes(s.level)) {
    s.tanks++;
    s.tanksMax = Math.max(s.tanksMax, s.tanks);
  }
  if (mode.pingAt.includes(s.level)) s.pings++;
  s.tideMaxMs = tideForLevel(mode, s.level, s.divers.length);
  s.tideMs = s.tideMaxMs;
  s.phase = 'diving';
}

/**
 * A diver left mid-level. Their cards come up face-up and the level continues.
 *
 * Deliberately not "remove the diver": the frozen roster has to keep its indices
 * or every peer's stats land on the wrong name. They stay in the crew with an
 * empty hand, which is also what the results screen wants to show.
 */
export function diverLeft(s: DiveState, i: number): void {
  if (s.phase !== 'diving' && s.phase !== 'clear') return;
  const hand = s.hands[i];
  if (!hand || !hand.length) return;
  const lost: Dredged[] = hand.map((depth) => ({ depth, by: i, cause: 'left' as const }));
  s.stats[i].lost += lost.length;
  s.hands[i] = [];
  s.dredged.push(...lost);
  s.holding[i] = false;
  // Same reason as fireSonar: a dredged card never reached the line, so the
  // floor stays where the last surfaced card left it.
  afterRemoval(s);
}

/** Drain the event queue. */
export function takeEvents(s: DiveState): DiveEvent[] {
  const out = s.events;
  s.events = [];
  return out;
}

/** 0..1 — how far the level's tide has run down. */
export const tideFrac = (s: DiveState): number =>
  s.tideMaxMs <= 0 ? 0 : Math.max(0, Math.min(1, s.tideMs / s.tideMaxMs));
