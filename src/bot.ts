/**
 * bot.ts — an AI diver that plays the game a human plays.
 *
 * It is deliberately HONEST: it reads only its own hand plus what is public
 * (the floor, the tide, the deck depth, how many cards are still out). It cannot
 * see anyone else's cards. That matters far beyond fairness — the balance sim
 * measures this bot, so a bot that peeked would measure a different game and
 * every number in tests/balance.test.ts would be a lie.
 *
 * Its whole policy is the human one: wait a length of time proportional to the
 * gap between your shallowest card and the current floor, then release. The
 * information in this game is carried by silence, and this is what makes silence
 * mean something — a diver sitting still for a long time really is holding
 * something deep. Jitter (tuning.JITTER) is the human hand shaking, and it is
 * the only thing that ever makes a crew misplay.
 */

import { makeRng, type Rng } from './engine/rng';
import { type DiveState } from './game';
import {
  JITTER,
  JITTER_MS,
  RUSH_MIN,
  RUSH_SPAN,
  JOIN_K,
  SONAR_DANGER_K,
  SONAR_PATIENCE_MS,
  TENSION_K,
} from './tuning';

export interface BotAction {
  /** Surface my shallowest card this tick. */
  play: boolean;
  /** Whether I am signalling for sonar. */
  signal: boolean;
}

export interface Bot {
  readonly index: number;
  decide(s: DiveState, dtMs: number): BotAction;
}

const BOT_SALT = 0x85ebca6b;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Ms of patience per unit of depth-gap, scaled to this level's tide. */
export function tensionPerDepth(s: DiveState): number {
  return (s.tideMaxMs * TENSION_K) / s.deckMax;
}

/**
 * How long a diver holding `depth` should wait, measured from when the floor
 * last moved. Exported because the balance sim's readout is only meaningful next
 * to the rule that produced it, and tests pin its shape.
 */
export function waitFor(
  s: DiveState,
  depth: number,
  jitter: number,
  flat = 0,
  k: { jitter?: number; jitterMs?: number } = {},
): number {
  const base = tensionPerDepth(s) * (depth - s.floor);
  return Math.max(0, base * (1 + (k.jitter ?? JITTER) * jitter) + (k.jitterMs ?? JITTER_MS) * flat);
}

export interface BotOpts {
  /** Override tuning.SONAR_DANGER_K — the balance sim sweeps this. */
  dangerK?: number;
  /** Override tuning.SONAR_PATIENCE_MS. */
  patienceMs?: number;
  /** Override tuning.JITTER / JITTER_MS — the balance sim sweeps these. */
  jitter?: number;
  jitterMs?: number;
}

export function createBot(index: number, seed: number, opts: BotOpts = {}): Bot {
  const dangerK = opts.dangerK ?? SONAR_DANGER_K;
  const patienceMs = opts.patienceMs ?? SONAR_PATIENCE_MS;
  const rng: Rng = makeRng((seed >>> 0) ^ Math.imul(index + 1, BOT_SALT));
  let lastCard = -1;
  let lastFloor = -1;
  let wait = 0;
  /** How long this diver has been signalling since the floor last moved. */
  let signalMs = 0;

  return {
    index,
    decide(s: DiveState, dtMs: number): BotAction {
      const idle: BotAction = { play: false, signal: false };
      if (s.phase !== 'diving') return idle;
      const hand = s.hands[index];
      if (!hand || !hand.length) return idle;
      const depth = hand[0];

      // Re-read the table whenever the situation changed: a new card in hand, or
      // the floor moving under the one we hold. Re-rolling the jitter here is
      // deliberate — a diver genuinely does re-assess after every play.
      if (depth !== lastCard || s.floor !== lastFloor) {
        lastCard = depth;
        lastFloor = s.floor;
        wait = waitFor(s, depth, rng() * 2 - 1, rng() * 2 - 1, opts);
        signalMs = 0;
      }

      const gap = clamp01((depth - s.floor) / s.deckMax);

      // ── sonar ───────────────────────────────────────────────────────────────
      // Signal when MY card sits dangerously close above the floor. I cannot see
      // whether anyone else is closer — but the ping only fires if EVERY diver is
      // signalling, so unanimity is itself the evidence that the low cards are
      // clustered, which is the one situation a charge is worth spending on.
      // Signalling replaces playing: you cannot hold the card up and release it.
      // Give up after SONAR_PATIENCE_MS so a lone nervous diver never stalls the
      // crew waiting for a consensus that is not coming.
      // How far apart consecutive cards should sit, given what is still out.
      // Entirely public: how deep the deck runs below the floor, and how many
      // cards the crew still holds between them.
      const stillHeld = s.hands.reduce((n, h) => n + h.length, 0);
      const expectedGap = (s.deckMax - s.floor) / Math.max(1, stillHeld + 1);
      const mineIsClose = depth - s.floor < expectedGap * dangerK;

      // JOIN A SIGNAL ALREADY IN PROGRESS. `holding` is public — you can see a
      // teammate's thumb resting on their card — and at a real table that is
      // exactly what makes the gesture work: one person hesitates, everyone
      // else reads it and joins.
      //
      // Without this the mechanic measured as NEUTRAL, and worse than neutral
      // once the control arm was fixed. The reason is that signalling stops you
      // playing, so a signal that never reaches consensus is pure wasted tide,
      // and lone signallers were paying that cost constantly. Joining converts
      // most attempts into an actual ping instead of a shared stall. Join on a
      // much looser threshold than you would start on: trusting a scared
      // teammate costs you a card you were about to play anyway.
      const someoneElseHolding = s.holding.some((h, i) => h && i !== index);
      const worthJoining = depth - s.floor < expectedGap * dangerK * JOIN_K;
      const inDanger = mineIsClose || (someoneElseHolding && worthJoining);

      if (s.pings > 0 && inDanger && signalMs < patienceMs) {
        signalMs += dtMs;
        return { play: false, signal: true };
      }

      // Politeness ends with the tide. The cap scales with the gap, so divers
      // holding SHALLOW cards break first and the scramble mostly resolves in
      // the right order instead of being a four-way coin flip.
      const rushCap = s.tideMs * (RUSH_MIN + RUSH_SPAN * gap);
      return { play: s.sinceFloorMs >= Math.min(wait, rushCap), signal: false };
    },
  };
}
