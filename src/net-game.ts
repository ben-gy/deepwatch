/**
 * net-game.ts — one dive, driven either solo or across a peer-to-peer room.
 *
 * Host-authoritative star. The host owns the clock, adjudicates every surface
 * against the deterministic deck, and broadcasts public state at 10Hz. Guests
 * send two things and only two things: "I released" and "I am signalling". No
 * card value ever crosses the wire, and there is no chat channel — by design.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HANDS ARE NEVER SENT. They are DERIVED.
 *
 * The deal is a pure function of (seed, level), both of which ride in the round
 * start, and every snapshot carries the full surfaced + dredged lists. Since all
 * cards in a level are distinct, "dealt minus gone" reconstructs every hand
 * exactly. So each peer computes the table locally and simply renders only its
 * own hand.
 *
 * That buys three things at once:
 *  - a tiny snapshot that never grows with hand size;
 *  - a peer promoted mid-level already holds complete authoritative state, so
 *    takeOver() is just "start ticking" rather than a state transfer;
 *  - no window where the new host knows less than the old one did.
 *
 * The honest cost, disclosed in the About panel: a determined player could
 * compute everyone's hand. This is a co-operative game for people who chose to
 * play together, and it is no more peekable than a real card table.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Net, PeerId } from '@ben-gy/game-engine/net';
import type { RoundPlayer } from '@ben-gy/game-engine/rematch';
import { createBot, type Bot } from './bot';
import {
  createDive,
  dealLevel,
  diverLeft,
  nextLevel,
  playCard,
  setHolding,
  step,
  takeEvents,
  type DiveEvent,
  type DiveState,
  type Diver,
  type Dredged,
  type Surfaced,
} from './game';
import type { ModeId } from './modes';

/** Host → everyone. Public state only; hands are derived, never carried. */
interface Snap {
  lv: number;
  fl: number;
  sf: Surfaced[];
  dr: Dredged[];
  tk: number;
  tm: number;
  pg: number;
  td: number;
  tx: number;
  ph: DiveState['phase'];
  hd: boolean[];
  st: DiveState['stats'];
  en: DiveState['ending'];
  fh: number[][] | null;
}

/** Guest → host. A release, or a change to my sonar signal. */
type Act = { t: 'p' } | { t: 's'; on: boolean };

export interface SessionOpts {
  modeId: ModeId;
  seed: number;
  players: RoundPlayer[];
  /** Index of the local player in `players`. -1 for a pure spectator. */
  myIndex: number;
  isHost: boolean;
  /** Absent for solo. */
  net?: Net;
  /** Solo only: which diver indices are AI. */
  botIndices?: number[];
  onChange: () => void;
  onEvents: (events: DiveEvent[]) => void;
  /** A level was cleared; the UI runs a countdown then calls resume(). */
  onLevelClear: () => void;
}

const TICK_MS = 60;
const SNAP_EVERY_MS = 100;

/**
 * Rebuild every hand for a level from the deal plus what has left play.
 * Exported for tests — this is the invariant host transfer rests on.
 */
export function rebuildHands(
  seed: number,
  level: number,
  divers: number,
  deckMax: number,
  gone: readonly number[],
): number[][] {
  const dealt = dealLevel(seed, level, divers, deckMax);
  const out = new Set(gone);
  return dealt.map((hand) => hand.filter((card) => !out.has(card)));
}

export class Session {
  readonly state: DiveState;
  readonly myIndex: number;
  isHost: boolean;

  private readonly opts: SessionOpts;
  private readonly bots: Bot[] = [];
  private sendAct: ((a: Act, to?: PeerId | PeerId[]) => void) & { off: () => void };
  private sendSnap: ((s: Snap, to?: PeerId | PeerId[]) => void) & { off: () => void };
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private sinceSnap = 0;
  private dead = false;
  /** Guest-side: greyed the moment you tap, so the room's latency is visible. */
  private pendingPlay = false;

  constructor(opts: SessionOpts) {
    this.opts = opts;
    this.myIndex = opts.myIndex;
    this.isHost = opts.isHost;

    const bots = new Set(opts.botIndices ?? []);
    const divers: Diver[] = opts.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      bot: bots.has(i),
    }));
    this.state = createDive({ modeId: opts.modeId, seed: opts.seed, divers });
    for (const i of bots) this.bots.push(createBot(i, opts.seed));

    const net = opts.net;
    if (net) {
      this.sendAct = net.channel<Act>('act', (a, from) => this.onAct(a, from));
      this.sendSnap = net.channel<Snap>('snap', (s, from) => this.onSnap(s, from));
    } else {
      const noop = Object.assign(() => {}, { off: () => {} });
      this.sendAct = noop as typeof this.sendAct;
      this.sendSnap = noop as typeof this.sendSnap;
    }
  }

  /** Begin ticking. Called after the countdown, on every peer. */
  start(): void {
    if (this.dead || this.timer) return;
    this.lastTick = Date.now();
    // setInterval, not rAF: a backgrounded host must keep the tide running or
    // the whole crew is frozen behind a tab nobody can see.
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (!this.isHost || this.state.phase !== 'diving') return;

    for (const bot of this.bots) {
      const a = bot.decide(this.state, dt);
      setHolding(this.state, bot.index, a.signal);
      if (a.play) playCard(this.state, bot.index);
      if (this.state.phase !== 'diving') break;
    }
    if (this.state.phase === 'diving') step(this.state, dt);

    this.drain();
    this.sinceSnap += dt;
    if (this.sinceSnap >= SNAP_EVERY_MS) {
      this.sinceSnap = 0;
      this.broadcast();
    }
    this.opts.onChange();
  }

  private drain(): void {
    const events = takeEvents(this.state);
    if (events.length) this.opts.onEvents(events);
    if (this.state.phase === 'clear') {
      this.stop();
      this.broadcast();
      this.opts.onLevelClear();
    } else if (this.state.phase === 'won' || this.state.phase === 'lost') {
      this.stop();
      this.broadcast();
    }
  }

  /** After the between-levels countdown. Host deals; guests follow the snapshot. */
  resume(): void {
    if (this.dead) return;
    if (this.isHost && this.state.phase === 'clear') {
      nextLevel(this.state);
      this.broadcast();
    }
    this.pendingPlay = false;
    this.start();
  }

  // ── local input ───────────────────────────────────────────────────────────

  play(): void {
    if (this.dead || this.myIndex < 0 || this.state.phase !== 'diving') return;
    if (!this.state.hands[this.myIndex]?.length) return;
    if (this.isHost) {
      playCard(this.state, this.myIndex);
      this.drain();
      this.broadcast();
      this.opts.onChange();
    } else {
      this.pendingPlay = true;
      this.sendAct({ t: 'p' });
      this.opts.onChange();
    }
  }

  setSignal(on: boolean): void {
    if (this.dead || this.myIndex < 0 || this.state.phase !== 'diving') return;
    if (this.isHost) {
      setHolding(this.state, this.myIndex, on);
      this.opts.onChange();
    } else {
      this.sendAct({ t: 's', on });
    }
  }

  /** True while a guest's release is in flight — the card greys out for it. */
  awaitingPlay(): boolean {
    return this.pendingPlay;
  }

  // ── wire ──────────────────────────────────────────────────────────────────

  private indexOf(id: PeerId): number {
    return this.state.divers.findIndex((d) => d.id === id);
  }

  private onAct(a: Act, from: PeerId): void {
    if (!this.isHost || this.state.phase !== 'diving') return;
    const i = this.indexOf(from);
    if (i < 0) return; // a spectator, or someone not in this round's roster
    if (a.t === 'p') {
      playCard(this.state, i);
      this.drain();
      this.broadcast();
      this.opts.onChange();
    } else {
      setHolding(this.state, i, a.on);
    }
  }

  private broadcast(): void {
    if (!this.isHost || !this.opts.net) return;
    const s = this.state;
    this.sendSnap({
      lv: s.level,
      fl: s.floor,
      sf: s.surfaced,
      dr: s.dredged,
      tk: s.tanks,
      tm: s.tanksMax,
      pg: s.pings,
      td: s.tideMs,
      tx: s.tideMaxMs,
      ph: s.phase,
      hd: s.holding,
      st: s.stats,
      en: s.ending,
      fh: s.finalHands,
    });
  }

  private onSnap(snap: Snap, from: PeerId): void {
    // Only the elected host may drive state, and never while we are the host —
    // otherwise a straggling snapshot from the peer we just replaced would
    // overwrite the run we are now responsible for.
    if (this.isHost || !this.opts.net || from !== this.opts.net.host()) return;
    const s = this.state;
    const wasPhase = s.phase;
    const wasLevel = s.level;

    s.level = snap.lv;
    s.floor = snap.fl;
    s.surfaced = snap.sf;
    s.dredged = snap.dr;
    s.tanks = snap.tk;
    s.tanksMax = snap.tm;
    s.pings = snap.pg;
    s.tideMs = snap.td;
    s.tideMaxMs = snap.tx;
    s.phase = snap.ph;
    s.holding = snap.hd;
    s.stats = snap.st;
    s.ending = snap.en;
    s.finalHands = snap.fh;
    s.hands = rebuildHands(s.seed, s.level, s.divers.length, s.deckMax, [
      ...snap.sf.map((c) => c.depth),
      ...snap.dr.map((c) => c.depth),
    ]);

    if (s.level !== wasLevel) this.pendingPlay = false;
    if (this.pendingPlay && !s.hands[this.myIndex]?.length) this.pendingPlay = false;
    // A guest cannot see the host's event queue, so derive the ones that matter
    // for sound and shake from the transitions it can observe.
    if (wasPhase !== s.phase) {
      if (s.phase === 'clear') {
        this.stop();
        this.opts.onLevelClear();
      } else if (s.phase === 'won' || s.phase === 'lost') {
        this.stop();
        this.opts.onEvents([{ t: s.phase === 'won' ? 'won' : 'lost' }]);
      }
    }
    this.opts.onChange();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Promoted to host mid-dive (contract gate #2).
   *
   * There is nothing to transfer: this peer's last snapshot plus the seed IS the
   * authoritative state (see the header). So taking over is resuming the clock,
   * and the run stays finishable.
   */
  takeOver(): void {
    if (this.dead || this.isHost) return;
    this.isHost = true;
    this.pendingPlay = false;
    this.sinceSnap = 0;
    this.lastTick = Date.now();
    this.broadcast();
    if (this.state.phase === 'diving') this.start();
    else if (this.state.phase === 'clear') this.opts.onLevelClear();
    this.opts.onChange();
  }

  /** A peer dropped: their cards surface face-up and the level carries on. */
  onPeerLeave(gone: PeerId): void {
    if (this.dead || !this.isHost) return;
    const i = this.indexOf(gone);
    if (i < 0) return;
    diverLeft(this.state, i);
    this.drain();
    this.broadcast();
    this.opts.onChange();
  }

  destroy(): void {
    this.dead = true;
    this.stop();
    this.sendAct.off();
    this.sendSnap.off();
  }
}
