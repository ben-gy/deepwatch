/**
 * takeover.test.ts — MULTIPLAYER CONTRACT GATE #2: the host leaving must not
 * freeze or end the dive.
 *
 * The automated half of the gate (the manual two-tab smoke test is the other).
 * A survivor stuck on a frozen gauge is the exact failure this exists to catch,
 * and it is invisible to every other test in the suite.
 *
 * Deepwatch's takeover is unusually cheap, and the test proves WHY: hands are
 * never transmitted, they are derived from (seed, level) minus what has left
 * play. So a guest already holds complete authoritative state at all times and
 * promotion is just "start the clock". The assertions below check both halves —
 * that a guest genuinely does NOT drive state before promotion, and that it
 * fully does after.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import type { RoundPlayer } from '@ben-gy/game-engine/rematch';
import { Session, rebuildHands } from '../src/net-game';
import { dealLevel } from '../src/game';
import { MODES, deckFor, levelsFor } from '../src/modes';

// A minimal two-peer bus. It sits above Trystero deliberately — the transport
// hazard is owned by net-lifecycle/trystero-rejoin; this is about our takeover.
class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  hostId: PeerId = 'a';
  join(id: PeerId): void {
    this.peers.set(id, new Map());
  }
  part(id: PeerId): void {
    this.peers.delete(id);
    if (this.hostId === id) this.hostId = [...this.peers.keys()].sort()[0] ?? '';
  }
  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to
      ? Array.isArray(to)
        ? to
        : [to]
      : [...this.peers.keys()].filter((p) => p !== from);
    for (const t of targets) for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
  }
  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => [...bus.peers.keys()].sort(),
    host: () => bus.hostId,
    isHost: () => bus.hostId === selfId,
    hostSettled: () => true,
    count: () => bus.peers.size,
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => bus.part(selfId),
  };
}

const PLAYERS: RoundPlayer[] = [
  { id: 'a', name: 'Ana' },
  { id: 'b', name: 'Bo' },
];

interface Table {
  bus: Bus;
  host: Session;
  guest: Session;
  cleared: { host: number; guest: number };
}

function table(seed = 4242, modeId: 'trench' | 'abyss' = 'trench'): Table {
  const bus = new Bus();
  const cleared = { host: 0, guest: 0 };
  const netA = mockNet(bus, 'a');
  const netB = mockNet(bus, 'b');
  const host = new Session({
    modeId,
    seed,
    players: PLAYERS,
    myIndex: 0,
    isHost: true,
    net: netA,
    onChange: () => {},
    onEvents: () => {},
    onLevelClear: () => cleared.host++,
  });
  const guest = new Session({
    modeId,
    seed,
    players: PLAYERS,
    myIndex: 1,
    isHost: false,
    net: netB,
    onChange: () => {},
    onEvents: () => {},
    onLevelClear: () => cleared.guest++,
  });
  return { bus, host, guest, cleared };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('hands are derived, never transmitted', () => {
  it('rebuilds exactly the cards still held', () => {
    const dealt = dealLevel(77, 4, 3, 90);
    const gone = [dealt[0][0], dealt[1][0], dealt[2][2]];
    const rebuilt = rebuildHands(77, 4, 3, 90, gone);
    expect(rebuilt[0]).toEqual(dealt[0].slice(1));
    expect(rebuilt[1]).toEqual(dealt[1].slice(1));
    expect(rebuilt[2]).toEqual(dealt[2].filter((c) => c !== dealt[2][2]));
  });

  it('gives an empty table back when everything has left play', () => {
    const dealt = dealLevel(9, 3, 2, 60);
    expect(rebuildHands(9, 3, 2, 60, dealt.flat())).toEqual([[], []]);
  });

  it('is what lets any peer reconstruct the whole table from a snapshot', () => {
    for (const n of [2, 3, 4]) {
      const mode = MODES.abyss;
      const deck = deckFor(mode, n);
      const level = levelsFor(mode, n);
      expect(rebuildHands(5, level, n, deck, [])).toEqual(dealLevel(5, level, n, deck));
    }
  });
});

describe('before promotion, a guest does not drive the dive', () => {
  it('never mutates shared state on its own clock', () => {
    const { host, guest } = table();
    host.start();
    guest.start();
    const before = {
      level: guest.state.level,
      tanks: guest.state.tanks,
      surfaced: guest.state.surfaced.length,
    };
    // Run the guest's timer hard with the host idle. Nothing may move.
    for (let i = 0; i < 50; i++) (guest as unknown as { tick(): void }).tick();
    expect(guest.state.level).toBe(before.level);
    expect(guest.state.tanks).toBe(before.tanks);
    expect(guest.state.surfaced).toHaveLength(before.surfaced);
    host.destroy();
    guest.destroy();
  });

  it('routes its own release through the host rather than applying it locally', () => {
    const { host, guest } = table();
    const guestCardCount = guest.state.hands[1].length;
    guest.play();
    // The host adjudicated it and the guest learned about it from the snapshot.
    expect(host.state.surfaced.length).toBe(1);
    expect(host.state.surfaced[0].by).toBe(1);
    expect(guest.state.hands[1].length).toBe(guestCardCount - 1);
    host.destroy();
    guest.destroy();
  });

  it('sees the host s state, including cards it could never have been told', () => {
    const { host, guest } = table();
    host.play();
    expect(guest.state.surfaced.map((c) => c.depth)).toEqual(
      host.state.surfaced.map((c) => c.depth),
    );
    expect(guest.state.hands.map((h) => h.length)).toEqual(host.state.hands.map((h) => h.length));
    host.destroy();
    guest.destroy();
  });
});

describe('after promotion, the survivor runs the dive', () => {
  it('adopts the state the departed host left, exactly', () => {
    const { bus, host, guest } = table();
    host.start();
    host.play();
    guest.play();
    const snapshot = {
      level: guest.state.level,
      floor: guest.state.floor,
      tanks: guest.state.tanks,
      surfaced: guest.state.surfaced.map((c) => c.depth),
    };

    host.destroy();
    bus.part('a');
    guest.takeOver();

    expect(guest.isHost).toBe(true);
    expect(guest.state.level).toBe(snapshot.level);
    expect(guest.state.floor).toBe(snapshot.floor);
    expect(guest.state.tanks).toBe(snapshot.tanks);
    expect(guest.state.surfaced.map((c) => c.depth)).toEqual(snapshot.surfaced);
    guest.destroy();
  });

  it('drives shared state once promoted — the tide runs again', () => {
    const { bus, host, guest } = table();
    host.destroy();
    bus.part('a');
    guest.takeOver();

    const before = guest.state.tideMs;
    (guest as unknown as { lastTick: number }).lastTick = Date.now() - 400;
    (guest as unknown as { tick(): void }).tick();
    expect(guest.state.tideMs).toBeLessThan(before);
    guest.destroy();
  });

  it('CAN STILL REACH GAME OVER — the run is finishable, not frozen', () => {
    const { bus, host, guest } = table(31, 'abyss');
    host.destroy();
    bus.part('a');
    guest.takeOver();

    // Let the tide run the dive out. A frozen survivor never gets here.
    for (let i = 0; i < 4000; i++) {
      const s = guest.state;
      if (s.phase === 'won' || s.phase === 'lost') break;
      if (s.phase === 'clear') guest.resume();
      (guest as unknown as { lastTick: number }).lastTick = Date.now() - 4000;
      (guest as unknown as { tick(): void }).tick();
    }
    expect(['won', 'lost']).toContain(guest.state.phase);
    guest.destroy();
  });

  it('applies its own release directly instead of posting it to a host that left', () => {
    const { bus, host, guest } = table();
    host.destroy();
    bus.part('a');
    guest.takeOver();
    guest.play();
    expect(guest.state.surfaced).toHaveLength(1);
    expect(guest.state.surfaced[0].by).toBe(1);
    expect(guest.awaitingPlay()).toBe(false);
    guest.destroy();
  });

  it('ignores a straggling snapshot from the host it replaced', () => {
    // Otherwise a packet already in flight overwrites the run the survivor is
    // now responsible for, and the dive rewinds under the player.
    const { bus, host, guest } = table();
    host.start();
    host.play();
    guest.takeOver();
    const mine = guest.state.surfaced.length;
    bus.send('a', 'snap', {
      lv: 9,
      fl: 99,
      sf: [],
      dr: [],
      tk: 1,
      tm: 3,
      pg: 0,
      td: 1,
      tx: 1,
      ph: 'diving',
      hd: [false, false],
      st: guest.state.stats,
      en: null,
      fh: null,
    });
    expect(guest.state.level).not.toBe(9);
    expect(guest.state.surfaced).toHaveLength(mine);
    host.destroy();
    guest.destroy();
  });
});

describe('a peer dropping mid-level', () => {
  it('brings their cards up and lets the rest carry on', () => {
    const { host, guest } = table();
    const gone = host.state.hands[1].length;
    expect(gone).toBeGreaterThan(0);
    host.onPeerLeave('b');
    expect(host.state.hands[1]).toEqual([]);
    expect(host.state.dredged.filter((c) => c.cause === 'left')).toHaveLength(gone);
    expect(['diving', 'clear']).toContain(host.state.phase);
    host.destroy();
    guest.destroy();
  });

  it('is ignored by a guest — only the host adjudicates', () => {
    const { host, guest } = table();
    guest.onPeerLeave('a');
    expect(guest.state.dredged).toHaveLength(0);
    host.destroy();
    guest.destroy();
  });
});
