// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — three dives that are genuinely different games, not one game with a
 * slider (principle #14).
 *
 * Shallows and Trench differ in stamina: more levels, fewer tanks, a faster
 * tide. Abyss changes the SPACE — the same number of cards squeezed into a deck
 * barely half as deep, so hands sit one or two apart constantly and the read
 * stops being about patience and becomes about nerve. That is a different game
 * to play, which is the bar a mode has to clear.
 *
 * The host's pick travels frozen inside the round start (rematch.ts roundOpts),
 * because deckMax and level count decide what gets DEALT: two peers on different
 * modes off one seed are two peers holding different cards.
 */

export type ModeId = 'shallows' | 'trench' | 'abyss';

export interface Mode {
  id: ModeId;
  name: string;
  blurb: string;
  /**
   * How deep the dive goes WITH TWO DIVERS. Level N deals N cards per diver, so
   * a bigger crew reaches the same total number of cards in fewer levels — see
   * levelsFor, which is what the game actually uses.
   */
  levels: number;
  /** Shared air tanks. Each mistake or tide surge burns one; zero ends the run. */
  tanks: number;
  /** Sonar charges the crew starts with. */
  pings: number;
  /**
   * How CROWDED the deepest level is: cards in play divided by the depth of the
   * deck they're drawn from. This, not a raw deck size, is what makes a mode
   * feel like itself — 0.2 means cards sit far apart and the read is about
   * patience; 0.6 means they sit one or two apart and it is about nerve.
   *
   * The deck is derived from it (deckFor) so density stays constant across party
   * sizes. A fixed deck did the opposite: an Abyss deck of 60 was a roomy 0.4 for
   * two divers and a hopeless 0.8 for four, and the sim showed exactly that — 69%
   * finishes at two divers, 0% at four. Party size should add hidden hands, not
   * silently switch the mode to a harder one.
   */
  density: number;
  /**
   * The tide allowance PER CARD IN THE LEVEL, in ms.
   *
   * Per-card, not per-level, and that distinction was the single biggest bug the
   * balance sim found. A flat per-level clock quietly meant a four-diver level 10
   * had to clear 40 cards in the same ~15s a two-diver level 1 got for 2 — under
   * 0.4s a card — so large parties were not "harder", they were impossible
   * (Trench finished 1% of runs at four divers against 99% at two). A level's
   * clock has to scale with the work in it.
   */
  tidePerCardMs: number;
  /** Each level tightens the per-card budget by this factor. */
  tideDecay: number;
  /**
   * Divers see only their next card, never the rest of their hand.
   *
   * A human-facing change, and honestly labelled as one: the AI in bot.ts only
   * ever reads its shallowest card anyway, so the balance sim cannot and does not
   * measure a difficulty difference from this. It changes how the mode FEELS to
   * play — no planning ahead, every card a fresh shock — not its numbers.
   */
  hiddenHand: boolean;
  /** Clearing these levels earns the crew a replacement air tank. */
  tankAt: readonly number[];
  /** Clearing these levels earns another sonar charge. */
  pingAt: readonly number[];
}

export const MODES: Record<ModeId, Mode> = {
  shallows: {
    id: 'shallows',
    name: 'Shallows',
    blurb: 'Eight levels, four tanks, a patient tide. Learn to read the silence.',
    levels: 8,
    tanks: 4,
    pings: 2,
    density: 0.18,
    tidePerCardMs: 5400,
    tideDecay: 0.97,
    hiddenHand: false,
    tankAt: [3, 6],
    pingAt: [4],
  },
  trench: {
    id: 'trench',
    name: 'Trench',
    blurb: 'Ten levels, three tanks, the tide closing faster. The standard dive.',
    levels: 10,
    tanks: 3,
    pings: 2,
    density: 0.3,
    tidePerCardMs: 4300,
    tideDecay: 0.95,
    hiddenHand: false,
    tankAt: [4, 8],
    pingAt: [5],
  },
  abyss: {
    id: 'abyss',
    name: 'Abyss',
    blurb: 'Twelve levels in a deck barely wider than the hands — every card is a near miss.',
    levels: 12,
    tanks: 3,
    pings: 1,
    density: 0.55,
    tidePerCardMs: 4300,
    tideDecay: 0.93,
    hiddenHand: true,
    tankAt: [4, 8],
    pingAt: [6, 10],
  },
};

export const MODE_IDS: readonly ModeId[] = ['shallows', 'trench', 'abyss'];

export const DEFAULT_MODE: ModeId = 'trench';

/**
 * Resolve a mode id that arrived off the wire or out of storage.
 *
 * `MODES[id] ?? DEFAULT` is NOT good enough: 'constructor' and 'toString' are
 * truthy properties of every object, so an untrusted key can hand back a
 * function where a Mode belongs and the generator then reads `undefined` for
 * every field. Object.hasOwn is the guard.
 */
export function modeOf(id: unknown): Mode {
  return typeof id === 'string' && Object.hasOwn(MODES, id)
    ? MODES[id as ModeId]
    : MODES[DEFAULT_MODE];
}

/**
 * The tide allowance for a level, in ms — the per-card budget times the number
 * of cards actually in the level, tightening as the dive gets deeper.
 */
export function tideForLevel(mode: Mode, level: number, divers: number): number {
  const cards = level * divers;
  return Math.round(mode.tidePerCardMs * cards * Math.pow(mode.tideDecay, Math.max(0, level - 1)));
}

/** Cards dealt across a whole dive of `levels` levels to `divers` divers. */
const totalCards = (levels: number, divers: number): number =>
  (divers * levels * (levels + 1)) / 2;

/**
 * How deep this mode goes for a crew of this size.
 *
 * A dive is defined by the TOTAL number of cards the crew has to get right, not
 * by a level count — so a bigger crew, dealt more cards per level, dives fewer
 * levels to face the same challenge. Two divers take Trench to level 10; four
 * take it to level 7, and both handle ~110 cards.
 *
 * This is the fix the balance sim forced, after tanks and deck width both failed.
 * A flat level count meant a four-diver Abyss had to clear 48 cards in its last
 * level alone and finished 0% of runs at every tank bonus tried, up to +3 per
 * diver. Physical games in this genre solve it exactly this way for the same
 * reason. Two divers is the quoted figure, so levelsFor(mode, 2) === mode.levels.
 */
export function levelsFor(mode: Mode, divers: number): number {
  const target = totalCards(mode.levels, 2);
  let best = 1;
  let bestErr = Infinity;
  for (let levels = 1; levels <= mode.levels; levels++) {
    const err = Math.abs(totalCards(levels, divers) - target);
    if (err < bestErr) {
      bestErr = err;
      best = levels;
    }
  }
  return best;
}

/**
 * The most cards a mode can ever need in one level. Every card in a level is
 * distinct, so a mode whose deepest level needs more cards than its deck holds
 * cannot be dealt — asserted in tests, because it would only surface at the
 * final level of a full crew's run.
 */
export function maxCardsNeeded(mode: Mode, divers: number): number {
  return levelsFor(mode, divers) * divers;
}

/**
 * The depth of the deck for this mode at this party size, chosen so the deepest
 * level lands at the mode's density. The `max` is the safety floor: a deck can
 * never be shallower than the number of distinct cards the last level deals.
 *
 * Note the deck's width is a READABILITY choice, not a difficulty one — the sim
 * showed scaling it from 1x to 2.8x moved the finish rate by noise. See
 * tuning.JITTER for why (a purely proportional error makes every absolute scale
 * cancel). It sets how tightly silhouettes crowd the gauge, which is what makes
 * Abyss look and feel like Abyss.
 */
export function deckFor(mode: Mode, divers: number): number {
  const cards = maxCardsNeeded(mode, divers);
  return Math.max(cards, Math.ceil(cards / mode.density));
}
