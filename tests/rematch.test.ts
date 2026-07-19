/**
 * rematch.test.ts — the multi-round protocol, driven with N simulated peers.
 *
 *  - COVERED: our round protocol. Votes, quorum, monotonic round numbers, the
 *    frozen roster, the host's mode travelling frozen, host handover mid-results.
 *  - NOT COVERED: the transport bug. A fake bus sits ABOVE Trystero's room cache,
 *    so it cannot contain that defect — net-lifecycle.test.ts and
 *    trystero-rejoin.test.ts own it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo } from '@ben-gy/game-engine/rematch';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import { MODES } from '../src/modes';

class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** Roster watchers, per peer — the bus side of Net.onPeersChange. */
  watchers = new Map<PeerId, Set<(peers: PeerId[]) => void>>();
  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.announce();
  }
  part(id: PeerId): void {
    this.peers.delete(id);
    this.watchers.delete(id);
    this.announce();
  }
  /** Tell every remaining peer the roster moved, as a real mesh would. */
  announce(): void {
    const roster = this.roster();
    for (const [id, set] of this.watchers) {
      if (!this.peers.has(id)) continue;
      for (const cb of set) cb(roster);
    }
  }
  watch(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    if (!this.watchers.has(id)) this.watchers.set(id, new Set());
    this.watchers.get(id)!.add(cb);
    return () => this.watchers.get(id)?.delete(cb);
  }
  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }
  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) {
      for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
    }
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
    peers: () => bus.roster(),
    host: () => bus.roster()[0] ?? null,
    isHost: () => bus.roster()[0] === selfId,
    hostSettled: () => true,
    // The fake bus has no partitions, so the term never advances past the first.
    hostEpoch: () => 1,
    count: () => bus.roster().length,
    onPeersChange: (cb) => bus.watch(selfId, cb),
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
    // Host is derived from the bus roster here, so an explicit takeover has
    // nothing to mint; these tests never exercise it.
    takeover: () => {},
    netDiag: () => ({
      selfId,
      host: bus.roster()[0] ?? null,
      epoch: 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
    leave: async () => bus.part(selfId),
  };
}

const modeOf = (i: RoundInfo): string | undefined => (i.opts as { mode?: string } | undefined)?.mode;

interface Seat {
  id: PeerId;
  net: Net;
  rounds: ReturnType<typeof createRounds>;
  got: RoundInfo[];
}

function table(ids: PeerId[], opts: { minPlayers?: number; modes?: Record<string, string> } = {}): Seat[] {
  const bus = new Bus();
  return ids.map((id) => {
    const net = mockNet(bus, id);
    const seat: Seat = { id, net, rounds: null as never, got: [] };
    seat.rounds = createRounds({
      net,
      playerName: id.toUpperCase(),
      minPlayers: opts.minPlayers ?? 2,
      roundOpts: opts.modes ? () => ({ mode: opts.modes![id] }) : undefined,
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
}

let seats: Seat[];
beforeEach(() => {
  seats = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Let the roster hold still long enough for the host to trust it, then let the
 * next poll tick act on that.
 *
 * Engine v1.1.0 deliberately refuses to freeze a roster from a mesh that is
 * still forming: an autostart is deferred until ROSTER_SETTLE_MS (4s) has passed
 * with no join or leave, and a 1.5s poll retries it afterwards. That deferral IS
 * the fix for players being "ejected" the moment a round began — the host used
 * to snapshot a half-connected room and everyone missing from that snapshot was
 * left behind. So a synchronous vote no longer starts a round synchronously;
 * every test that expects a start has to wait the room out, exactly as a real
 * room now does. 6000ms = the 4s window plus the poll tick that follows it.
 */
const settle = (): void => vi.advanceTimersByTime(6000);

describe('createRounds — starting a round', () => {
  it('starts once every peer has voted, with one host and an identical seed', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats.map((s) => s.got.length)).toEqual([1, 1]);
    expect(seats[0].got[0].seed).toBe(seats[1].got[0].seed);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
    expect(seats[0].got[0].round).toBe(1);
  });

  it('freezes ONE roster into the start, so player indices match on every peer', () => {
    seats = table(['b', 'a', 'c'], { minPlayers: 3 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    const rosters = seats.map((s) => s.got[0].players.map((p) => `${p.id}:${p.name}`));
    expect(rosters[0]).toEqual(rosters[1]);
    expect(rosters[1]).toEqual(rosters[2]);
    expect(rosters[0]).toEqual(['a:A', 'b:B', 'c:C']);
  });

  it('waits below quorum', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 3 });
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
    seats[2].rounds.vote();
    settle();
    expect(seats.every((s) => s.got.length === 1)).toBe(true);
  });

  it('fills a full 4-player table with one seed and one roster', () => {
    seats = table(['a', 'b', 'c', 'd'], { minPlayers: 4 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats.map((s) => s.got.length)).toEqual([1, 1, 1, 1]);
    const seeds = new Set(seats.map((s) => s.got[0].seed));
    expect(seeds.size).toBe(1);
    for (const s of seats) expect(s.got[0].players.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
  });

  it('lets the host start early with go(), leaving a non-voter out of the roster', () => {
    seats = table(['a', 'b', 'c']);
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(0);
    // go() is the host's explicit decision, so it is not gated on the settle
    // window the way an autostart is — it must fire on the spot.
    seats[0].rounds.go();
    expect(seats[0].got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores a start from a peer that is not the host', () => {
    seats = table(['a', 'b']);
    seats[1].net.channel('rs', () => {})({
      round: 1,
      seed: 42,
      roster: [{ id: 'b', name: 'B' }],
    } as never);
    settle();
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
  });
});

describe("createRounds — the host's mode travels frozen", () => {
  it("gives every peer the HOST's mode, not the one their own menu is set to", () => {
    // The guest is sitting on Abyss. It must dive the host's Shallows, because a
    // mode decides how many LEVELS the dive runs and how deep the deck goes — so
    // a guest dealing itself an Abyss hand off the host's seed is holding cards
    // that are not on the host's table at all.
    seats = table(['a', 'b'], { modes: { a: 'shallows', b: 'abyss' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[0].net.isHost()).toBe(true);
    for (const s of seats) expect(modeOf(s.got[0])).toBe('shallows');
    for (const s of seats) expect(MODES[modeOf(s.got[0])!].levels).toBe(8);
  });

  it('follows the mode when the HOST is the one on Abyss', () => {
    seats = table(['a', 'b'], { modes: { a: 'abyss', b: 'shallows' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    for (const s of seats) expect(modeOf(s.got[0])).toBe('abyss');
    expect(MODES.abyss.levels).toBe(12);
  });

  it('carries the mode into every rematch, not just the first round', () => {
    seats = table(['a', 'b'], { modes: { a: 'trench', b: 'abyss' } });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();
    for (const s of seats) expect(modeOf(s.got[1])).toBe('trench');
  });

  it("gossips the host's mode into every peer's state, before any round starts", () => {
    seats = table(['a', 'b'], { modes: { a: 'abyss', b: 'shallows' } });
    for (const s of seats) expect(s.rounds.state().hostOpts).toEqual({ mode: 'abyss' });
  });

  it('hands back an undefined opts when a game does not use them', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[0].got[0].opts).toBeUndefined();
    expect(seats[1].got[0].opts).toBeUndefined();
  });
});

describe('createRounds — the rematch (the bug this all exists for)', () => {
  it('runs a second round in the SAME room, both peers together, one host', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats.map((s) => s.got.length)).toEqual([2, 2]);
    expect(seats[0].got[1].round).toBe(2);
    expect(seats[0].got[1].seed).toBe(seats[1].got[1].seed);
    expect(seats.filter((s) => s.got[1].isHost)).toHaveLength(1);
    expect(seats[0].got[1].seed).not.toBe(seats[0].got[0].seed);
  });

  it('lets a peer that LEFT and rejoined mid-match ready up again', () => {
    const bus = new Bus();
    const mk = (id: PeerId) => {
      const net = mockNet(bus, id);
      const seat: Seat = { id, net, rounds: null as never, got: [] };
      seat.rounds = createRounds({
        net,
        playerName: id.toUpperCase(),
        minPlayers: 2,
        onRound: (info) => seat.got.push(info),
      });
      return seat;
    };
    const a = mk('a');
    let b = mk('b');
    a.rounds.vote();
    b.rounds.vote();
    settle();
    expect(a.got[0].round).toBe(1);
    b.rounds.destroy();
    void b.net.leave();
    a.rounds.finish();
    b = mk('b');
    a.rounds.vote();
    b.rounds.vote();
    // The rejoin moved the roster, so the host waits it out again before
    // freezing round 2 — that wait is precisely what gets the rejoiner seated
    // instead of stranded.
    settle();
    expect(b.got.length, 'the rejoiner reached a new round').toBe(1);
    expect(a.got.length).toBe(2);
    expect(a.got[1].round).toBe(2);
    expect(b.got[0].round).toBe(2);
    expect(a.got[1].seed).toBe(b.got[0].seed);
    expect([a, b].filter((s) => s.got[s.got.length - 1].isHost)).toHaveLength(1);
  });

  it("keeps both peers in each other's roster across the rematch", () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    settle();
    for (const s of seats) {
      expect(s.got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s.net.count()).toBe(2);
    }
  });

  it('ignores a stale or duplicated start rather than restarting a live round', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    const seed = seats[0].got[0].seed;
    seats[0].net.channel('rs', () => {})({
      round: 1,
      seed: 999,
      roster: [{ id: 'a', name: 'A' }],
    } as never);
    expect(seats[1].got.length).toBe(1);
    expect(seats[1].got[0].seed).toBe(seed);
  });

  it('does not start a rematch while a round is still being played', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[0].got.length).toBe(1);
  });

  it('drops the vote of a peer who leaves, and still rematches the rest', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1);
    seats[2].net.leave();
    seats[0].rounds.vote();
    settle();
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('createRounds — host handover', () => {
  it('promotes the next peer and still starts when the host leaves at results', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    expect(seats[0].net.isHost()).toBe(true);
    seats[0].net.leave();
    expect(seats[1].net.isHost()).toBe(true);
    seats[1].rounds.vote();
    seats[2].rounds.vote();
    settle();
    expect(seats[1].got.length).toBe(2);
    expect(seats[1].got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(seats[1].got[1].isHost).toBe(true);
    expect(seats[2].got[1].isHost).toBe(false);
    expect(seats[1].got[1].seed).toBe(seats[2].got[1].seed);
  });
});

describe('createRounds — never deadlock waiting for a vote that never comes', () => {
  it('starts anyway once the grace countdown expires, without the silent player', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    // finish() re-arms the settle window on purpose, so the first rematch after
    // a long game cannot start instantly on whoever happens to be visible. The
    // grace countdown is armed by the poll tick once that window has passed.
    settle();
    expect(seats[0].got.length).toBe(1);
    const s = seats[0].rounds.state();
    expect(s.startsInMs).not.toBeNull();
    expect(s.startsInMs!).toBeGreaterThan(0);
    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('goes immediately when everyone votes, with no countdown', () => {
    seats = table(['a', 'b'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats.forEach((s) => s.rounds.vote());
    // Walk the whole settle window rather than jumping it: unanimity must never
    // arm the grace countdown at ANY point, not merely fail to leave one behind.
    for (let t = 0; t < 6000; t += 500) {
      expect(seats[0].rounds.state().startsInMs).toBeNull();
      vi.advanceTimersByTime(500);
    }
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
    expect(seats[0].rounds.state().startsInMs).toBeNull();
  });

  it('lets the host force the rematch immediately with go()', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[0].rounds.go();
    expect(seats[0].got.length).toBe(2);
  });

  it('cancels the countdown if quorum is lost again', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    settle();
    expect(seats[0].rounds.state().startsInMs!).toBeGreaterThan(0);
    seats[1].rounds.unvote();
    expect(seats[0].rounds.state().startsInMs).toBeNull();
    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(1);
  });

  it('a peer who readies up mid-countdown still lands in the roster', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    settle();
    seats.forEach((s) => s.rounds.finish());
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[2].rounds.vote();
    settle();
    expect(seats[2].got.length).toBe(2);
    expect(seats[2].got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('createRounds — teardown', () => {
  it('stops answering once destroyed', () => {
    seats = table(['a', 'b']);
    seats[1].rounds.destroy();
    seats.forEach((s) => s.rounds.vote());
    settle();
    expect(seats[1].got.length).toBe(0);
  });
});
