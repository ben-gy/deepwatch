/**
 * main.ts — bootstrap and screen flow.
 *
 * mobile.css is imported FIRST so the game's own stylesheet can override any
 * single rule of it, and hardenViewport() runs before the first screen paints.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';

import { createNet, roomAppId, setTurnConfig, type Net, type PeerId } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type RoundInfo, type RoundPlayer, type Rounds } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
} from '@ben-gy/game-engine/lobby';
import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createStore } from '@ben-gy/game-engine/storage';
import { resolveName, withName } from '@ben-gy/game-engine/identity';
import { makeDraggable } from './engine/drag';
import { newSeed } from '@ben-gy/game-engine/rng';
import { startCountdown, type Countdown } from './countdown';
import { createSfx } from './sound';
import { DiveView, escapeHtml } from './render';
import { renderResults } from './results';
import { bubbles, shake, silt, sonarSweep } from './fx';
import { Session } from './net-game';
import { MODES, MODE_IDS, DEFAULT_MODE, levelsFor, modeOf, type ModeId } from './modes';
import { SONAR_HOLD_MS } from './tuning';
import type { DiveEvent } from './game';

const APP_ID = 'deepwatch';
const MAX_DIVERS = 4;

hardenViewport();

/**
 * Fetch the TURN credentials and hand them to net.ts BEFORE any mesh exists.
 *
 * Trystero builds ONE global RTCPeerConnection pool from the config of the very
 * first joinRoom on the page, so a setTurnConfig() that lands after that join is
 * silently ignored and the initiating half of every pair stays STUN-only —
 * which is exactly nothing on a carrier CGNAT, and was why peers never appeared
 * in each other's rooms. Kicking it off at boot rather than inside enterRoom()
 * means it is almost always resolved by the time a player types a code, and
 * getTurnConfig() is session-cached and fails open to [] so it can never block
 * or break a join if the credential endpoint is down.
 */
const turnReady = getTurnConfig().then((servers) => setTurnConfig(servers));

const store = createStore(APP_ID);
const sfx = createSfx(store.get('muted', false));
const app = document.querySelector<HTMLDivElement>('#app')!;

/**
 * Kept deliberately disjoint from BOT_NAMES. They overlapped in the first build
 * and a real solo dive came out with the player as "Diver Fathom" sitting next
 * to a bot called "Fathom" — in a game whose entire content is working out who
 * is holding back, two divers you cannot tell apart is not a cosmetic problem.
 */
const PLAYER_NAMES = ['Reef', 'Tide', 'Drift', 'Coral', 'Pearl', 'Anchor'] as const;
const BOT_NAMES = ['Kelp', 'Fathom', 'Silt'] as const;

const randomName = (): string =>
  `Diver ${PLAYER_NAMES[Math.floor(Math.random() * PLAYER_NAMES.length)]}`;
let playerName = resolveName(store, randomName);

let mode: ModeId = modeOf(store.get('mode', DEFAULT_MODE)).id;
let soloCrew = Math.min(MAX_DIVERS, Math.max(2, store.get('crew', 3)));

// ── room state (ONE Net per session — never leave and rejoin) ────────────────
let net: Net | null = null;
let rounds: Rounds | null = null;
let roomCode = '';
let session: Session | null = null;
let view: DiveView | null = null;
let countdown: Countdown | null = null;
let lobbyView: { destroy: () => void } | null = null;
let entryView: { destroy: () => void } | null = null;
let lastRound: RoundInfo | null = null;
let tally = { dives: 0, surfaced: 0 };
let renderQueued = false;

/**
 * `?room=` is honoured ONCE per page load. Leave it live and a reload — or
 * reopening from a home-screen icon — silently drags the player back into a room
 * they left, with no way to start a fresh one.
 */
let deepLink: string | null = (() => {
  const raw = new URL(location.href).searchParams.get('room');
  return raw ? normalizeRoomCode(raw) : null;
})();

const setPlaying = (on: boolean): void => {
  document.body.classList.toggle('playing', on);
};

const footer = `
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="${escapeHtml(withName('https://hub.benrichardson.dev', playerName))}" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;

function screen(inner: string, cls = ''): void {
  // Painting a new screen destroys the lobby's container, so the lobby itself
  // must go with it — it owns a repeating timer and (under ?netdebug=1) an
  // element parked on document.body that innerHTML here would never reach.
  // Doing it in one place is what lets showLobby() keep a LIVE lobby mounted
  // across repaints instead of rebuilding it, which is what the host-offer
  // timer needs to survive.
  lobbyView?.destroy();
  lobbyView = null;
  app.innerHTML = `<div class="main-content ${cls}">${inner}</div>${footer}`;
}

const muteBtn = (): string =>
  `<button class="btn ghost icon mute" type="button" aria-pressed="${sfx.muted()}" title="Sound">
     ${sfx.muted() ? '🔇' : '🔊'}<span class="sr">Sound</span>
   </button>`;

function wireMute(): void {
  app.querySelector('.mute')?.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    sfx.unlock();
    render();
  });
}

/** Every screen paints through here so a net event can safely request a repaint. */
function render(): void {
  if (screenState === 'menu') showMenu();
  else if (screenState === 'lobby') showLobby();
  else if (screenState === 'results') showResults();
}

function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    if (screenState === 'dive' && session && view) view.update(session.state, session.awaitingPlay());
    else render();
  });
}

type ScreenState = 'menu' | 'howto' | 'about' | 'entry' | 'lobby' | 'dive' | 'results';
let screenState: ScreenState = 'menu';

// ── menu ────────────────────────────────────────────────────────────────────

function showMenu(): void {
  screenState = 'menu';
  setPlaying(false);
  teardownDive();
  const m = MODES[mode];
  screen(
    `<header class="title">
       <h1>Deepwatch</h1>
       <p class="tag">Surface the deep in order. No numbers. No talking.</p>
     </header>

     <div class="menu">
       <div class="picker" role="radiogroup" aria-label="Dive">
         ${MODE_IDS.map(
           (id) => `<button class="mode${id === mode ? ' on' : ''}" type="button" role="radio"
              aria-checked="${id === mode}" data-mode="${id}">
              <b>${MODES[id].name}</b><span>${escapeHtml(MODES[id].blurb)}</span>
            </button>`,
         ).join('')}
       </div>
       <p class="picker-note">${levelsFor(m, soloCrew)} levels · ${m.tanks} air · ${m.pings} sonar${
         m.hiddenHand ? ' · you only ever see your next card' : ''
       }</p>

       <div class="crew-pick">
         <span>Crew</span>
         ${[2, 3, 4]
           .map(
             (n) =>
               `<button class="crewn${n === soloCrew ? ' on' : ''}" type="button" data-crew="${n}">${n}</button>`,
           )
           .join('')}
         <em>you + ${soloCrew - 1} AI diver${soloCrew === 2 ? '' : 's'}</em>
       </div>

       <button class="btn primary big play-solo" type="button">Dive</button>
       <button class="btn friends" type="button">Play with friends</button>
       <div class="menu-row">
         <button class="btn ghost howto" type="button">How to play</button>
         <button class="btn ghost about" type="button">About</button>
         ${muteBtn()}
       </div>
     </div>`,
    'menu-screen',
  );

  for (const el of app.querySelectorAll<HTMLElement>('.mode')) {
    el.addEventListener('click', () => {
      mode = modeOf(el.dataset.mode).id;
      store.set('mode', mode);
      sfx.unlock();
      sfx.play('select');
      showMenu();
    });
  }
  for (const el of app.querySelectorAll<HTMLElement>('.crewn')) {
    el.addEventListener('click', () => {
      soloCrew = Math.min(MAX_DIVERS, Math.max(2, Number(el.dataset.crew) || 3));
      store.set('crew', soloCrew);
      sfx.unlock();
      sfx.play('select');
      showMenu();
    });
  }
  app.querySelector('.play-solo')?.addEventListener('click', () => {
    sfx.unlock();
    startSolo();
  });
  app.querySelector('.friends')?.addEventListener('click', () => {
    sfx.unlock();
    showRoomEntry();
  });
  app.querySelector('.howto')?.addEventListener('click', () => showHowTo(false));
  app.querySelector('.about')?.addEventListener('click', showAbout);
  wireMute();

  if (!store.get('seenHowTo', false)) showHowTo(true);
}

// ── how to play / about ─────────────────────────────────────────────────────

function showHowTo(first: boolean): void {
  screenState = 'howto';
  screen(
    `<div class="sheet">
       <h2>How to play</h2>
       <ol class="rules">
         <li>Your crew surfaces creatures onto one line, <b>shallowest first</b> — but you
             can't see anyone else's cards, and <b>you can't talk</b>.</li>
         <li>There are no numbers. Your card's <b>height on the gauge</b> is how deep it is.
             Hold it while the tide climbs; release when you think nothing shallower is
             left below you.</li>
         <li>Surface out of order and every shallower card comes up face-up — and the
             crew loses an <b>air tank</b>. Out of air, the dive ends.</li>
         <li>Stuck? Everyone <b>press and hold together</b> to spend a <b>sonar ping</b>:
             each diver discards their shallowest card, face-up.</li>
       </ol>
       <p class="fine">Tap your card to surface · press and hold it to signal for sonar.
          On a keyboard: <kbd>Space</kbd> to surface, hold <kbd>S</kbd> to signal.</p>
       <button class="btn primary done" type="button">${first ? 'Got it' : 'Back'}</button>
     </div>`,
  );
  app.querySelector('.done')?.addEventListener('click', () => {
    store.set('seenHowTo', true);
    showMenu();
  });
}

function showAbout(): void {
  screenState = 'about';
  screen(
    `<div class="sheet">
       <h2>About Deepwatch</h2>
       <p>A co-operative game of nerve for two to four divers, played entirely in
          silence. It is a study in how much you can say by saying nothing.</p>
       <p><b>Multiplayer is peer-to-peer.</b> There is no game server. Browsers connect
          directly over WebRTC, and a free public signalling relay is used only to
          introduce them — after that, nothing touches a server of ours. Connecting
          shares your IP address with the people in your room, which is why rooms are
          invite-only and there is no public lobby.</p>
       <p><b>There is no chat channel, by design.</b> Not a muted one — there simply
          isn't one. The silence is the game.</p>
       <p><b>A note on trust.</b> Every hand is dealt from one shared seed that all
          players' browsers can compute, which is what lets any player take over
          running the game if the host disconnects. It also means a determined person
          could work out your cards. It's a game for people who chose to play together
          — no more peekable than a real card table nobody leans across.</p>
       <p>No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
          page-view counts via Cloudflare Web Analytics.</p>
       <button class="btn primary done" type="button">Back</button>
     </div>`,
  );
  app.querySelector('.done')?.addEventListener('click', showMenu);
}

// ── solo ────────────────────────────────────────────────────────────────────

function startSolo(): void {
  // A stored or link-carried name could still collide with a bot's, so the
  // crew is de-duplicated rather than trusting the two pools to stay disjoint.
  const taken = new Set([playerName.toLowerCase()]);
  const botName = (i: number): string => {
    const base: string = BOT_NAMES[i] ?? `AI ${i + 1}`;
    let name = base;
    let n = 2;
    while (taken.has(name.toLowerCase())) name = `${base} ${n++}`;
    taken.add(name.toLowerCase());
    return name;
  };
  const players: RoundPlayer[] = [
    { id: 'you', name: playerName },
    ...Array.from({ length: soloCrew - 1 }, (_, i) => ({ id: `ai${i}`, name: botName(i) })),
  ];
  lastRound = { round: 1, seed: newSeed(), players, isHost: true, seated: true, opts: { mode } };
  beginDive(players, 0, true, undefined, lastRound.seed, mode);
}

// ── multiplayer ─────────────────────────────────────────────────────────────

function showRoomEntry(): void {
  screenState = 'entry';
  setPlaying(false);
  // A deep link is consumed exactly once, then the entry screen is the way in.
  if (deepLink) {
    const code = deepLink;
    deepLink = null;
    void enterRoom(code, false);
    return;
  }
  screen('<div class="sheet"><div class="entry-host"></div></div>');
  entryView = createRoomEntry({
    container: app.querySelector<HTMLElement>('.entry-host')!,
    onSubmit: (code, created) => void enterRoom(code, created),
    onCancel: () => showMenu(),
  });
}

async function enterRoom(code: string, created: boolean): Promise<void> {
  entryView?.destroy();
  entryView = null;
  roomCode = normalizeRoomCode(code);
  setRoomInUrl(roomCode);

  // The TURN fetch started at boot; this is the last moment it can still matter,
  // because createNet() below is this page's first joinRoom and Trystero freezes
  // its ICE config there. turnReady never rejects.
  await turnReady;

  // ONE join for the whole session. Rounds are versioned inside it by
  // rematch.ts; nothing here ever calls leave() to "reset".
  net = createNet(
    { appId: roomAppId(APP_ID), roomId: roomCode, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => {
        if (isSelfHost) session?.takeOver();
        queueRender();
      },
      onPeerLeave: (id) => {
        session?.onPeerLeave(id);
        queueRender();
      },
      onPeers: () => queueRender(),
    },
  );

  rounds = createRounds({
    net,
    playerName,
    minPlayers: 2,
    // The HOST's mode is what the room plays, frozen into the start. A mode
    // decides how many levels the dive runs and how crowded the deck is; two
    // peers reading their own menus would be dealt different games.
    roundOpts: () => ({ mode }),
    onRound: (info) => onRoundStart(info),
    onChange: () => queueRender(),
  });

  showLobby();
}

/**
 * The mode strip under the lobby — the only part of this screen the GAME owns.
 *
 * It is repainted on its own, without touching the lobby beneath it, because
 * createLobby() is stateful now: it times how long this peer has sat alone and
 * unsettled, and after 15s offers "Nobody's here yet — host this room", which is
 * the only escape from an invite-link room whose mesh never formed. Rebuilding
 * the lobby on every roster tick restarts that clock, so the offer never
 * arrives and the player waits on a spinner forever. (It also leaked a 600ms
 * interval and a debug overlay per rebuild — this screen had accumulated 34 of
 * each within twenty seconds.)
 */
function paintLobbyModes(): void {
  const host = app.querySelector<HTMLElement>('.lobby-modes');
  if (!host || !net || !rounds) return;
  const hostMode = modeOf((rounds.state().hostOpts as { mode?: string } | null)?.mode);
  host.innerHTML = `
    <p class="lobby-mode">Diving <b>${hostMode.name}</b> — ${escapeHtml(hostMode.blurb)}
      <em>${net.isHost() ? 'your choice, as host' : "the host's choice"}</em></p>
    ${net.isHost() ? `<div class="picker small" role="radiogroup" aria-label="Dive">${MODE_IDS.map(
      (id) => `<button class="mode${id === mode ? ' on' : ''}" type="button" role="radio"
         aria-checked="${id === mode}" data-mode="${id}"><b>${MODES[id].name}</b></button>`,
    ).join('')}</div>` : ''}`;

  for (const el of host.querySelectorAll<HTMLElement>('.picker.small .mode')) {
    el.addEventListener('click', () => {
      mode = modeOf(el.dataset.mode).id;
      store.set('mode', mode);
      sfx.play('select');
      paintLobbyModes();
    });
  }
}

function showLobby(): void {
  screenState = 'lobby';
  setPlaying(false);
  teardownDive();
  if (!net || !rounds) return showMenu();

  // Already mounted: repaint only our own chrome and leave the lobby alone.
  if (lobbyView) return paintLobbyModes();

  screen(
    `<div class="sheet">
       <div class="lobby-host"></div>
       <div class="lobby-modes"></div>
     </div>`,
  );

  lobbyView = createLobby({
    container: app.querySelector<HTMLElement>('.lobby-host')!,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: MAX_DIVERS,
    onCancel: () => void leaveRoom(),
  });

  paintLobbyModes();
}

async function leaveRoom(): Promise<void> {
  teardownDive();
  lobbyView?.destroy();
  lobbyView = null;
  rounds?.destroy();
  rounds = null;
  const n = net;
  net = null;
  roomCode = '';
  tally = { dives: 0, surfaced: 0 };
  // Drop ?room= on the way out, or a reload teleports the player back in.
  clearRoomInUrl();
  showMenu();
  // Awaited so Trystero has genuinely retired the room before any future join.
  try {
    await n?.leave();
  } catch {
    /* leaving is best-effort */
  }
}

function onRoundStart(info: RoundInfo): void {
  lastRound = info;

  // The round started without us: we joined mid-dive, or our vote never reached
  // the host before it froze the roster. Leaving the lobby mounted is the whole
  // fix — it renders its spectating view with the ready toggle still live, so we
  // are queued for the next round. Diving anyway would seat us at index -1,
  // which is what "I got ejected" looked like from the player's seat.
  if (!info.seated) {
    if (screenState !== 'lobby') showLobby();
    return;
  }

  lobbyView?.destroy();
  lobbyView = null;
  const roundMode = modeOf((info.opts as { mode?: string } | undefined)?.mode).id;
  const myIndex = info.players.findIndex((p) => p.id === net?.selfId);
  beginDive(info.players, myIndex, info.isHost, net ?? undefined, info.seed, roundMode);
}

// ── the dive ────────────────────────────────────────────────────────────────

function teardownDive(): void {
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
  view?.destroy();
  view = null;
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
}

function beginDive(
  players: RoundPlayer[],
  myIndex: number,
  isHost: boolean,
  netRef: Net | undefined,
  seed: number,
  modeId: ModeId,
): void {
  teardownDive();
  screenState = 'dive';
  setPlaying(true);

  const botIndices = netRef ? [] : players.map((_, i) => i).filter((i) => i !== myIndex);

  session = new Session({
    modeId,
    seed,
    players,
    myIndex,
    isHost,
    net: netRef,
    botIndices,
    onChange: () => queueRender(),
    onEvents: (events) => onDiveEvents(events),
    onLevelClear: () => runCountdown(true),
  });

  view = new DiveView({
    myIndex,
    onPlay: () => session?.play(),
    onSignal: (on) => session?.setSignal(on),
  });

  screen('<div class="dive-host"></div>', 'dive-screen');
  app.querySelector('.dive-host')!.appendChild(view.root);

  wireCard();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  view.update(session.state, false);
  runCountdown(false);
}

function wireCard(): void {
  if (!view || !session) return;
  // Tap surfaces; press-and-hold signals for sonar. One target, two gestures,
  // both in the thumb zone — see engine/drag.ts for why a hold must never also
  // resolve as a tap.
  makeDraggable(view.cardEl, {
    holdMs: 260,
    onTap: () => {
      sfx.unlock();
      session?.play();
    },
    onHoldStart: () => {
      sfx.unlock();
      sfx.play('charge');
      session?.setSignal(true);
      queueRender();
    },
    onHoldEnd: () => {
      session?.setSignal(false);
      queueRender();
    },
    onCancel: () => session?.setSignal(false),
  });
}

let holdingKey = false;
function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    sfx.unlock();
    session?.play();
  } else if (e.code === 'KeyS') {
    e.preventDefault();
    holdingKey = true;
    sfx.unlock();
    sfx.play('charge');
    session?.setSignal(true);
    queueRender();
  } else if (e.code === 'Escape') {
    void confirmQuit();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.code === 'KeyS' && holdingKey) {
    holdingKey = false;
    session?.setSignal(false);
    queueRender();
  }
}

function confirmQuit(): void {
  if (net) showLobby();
  else showMenu();
}

function runCountdown(betweenLevels: boolean): void {
  if (!session || !view) return;
  countdown?.cancel();
  const host = view.root;
  // Sweep up any overlay a previous countdown left behind. cancel() stops the
  // timer but cannot remove the element, and the fade-out removal is on its own
  // 320ms timer, so re-entering here (next level, a host takeover, a rematch)
  // could orphan one. Each is a full-screen dim + backdrop-filter layer; they
  // are pointer-events:none so they never eat a tap, but stacked they quietly
  // darken the gauge until the game looks broken.
  for (const stale of host.querySelectorAll('.countdown')) stale.remove();
  const overlay = document.createElement('div');
  overlay.className = 'countdown';
  host.appendChild(overlay);

  countdown = startCountdown({
    from: betweenLevels ? 3 : 3,
    beatMs: 700,
    onBeat: (n) => {
      overlay.textContent = n > 0 ? String(n) : 'DIVE';
      overlay.classList.toggle('go', n === 0);
      sfx.play(n > 0 ? 'beat' : 'go');
    },
    onDone: () => {
      setTimeout(() => overlay.remove(), 320);
      if (betweenLevels) session?.resume();
      else session?.start();
      queueRender();
    },
  });
}

function onDiveEvents(events: DiveEvent[]): void {
  if (!view || !session) return;
  const gauge = view.root.querySelector<HTMLElement>('.gauge');
  const s = session.state;

  for (const e of events) {
    if (e.t === 'surface') {
      sfx.play('surface', { depth: e.depth / Math.max(1, e.deckMax) });
      if (gauge) bubbles(gauge, (e.depth / Math.max(1, s.deckMax)) * 100);
    } else if (e.t === 'misplay') {
      sfx.play('misplay');
      sfx.play('tank');
      shake(view.root, 'big');
      if (gauge) for (const l of e.lost) silt(gauge, (l.depth / Math.max(1, s.deckMax)) * 100);
    } else if (e.t === 'tide') {
      sfx.play('tank');
      shake(view.root, 'big');
    } else if (e.t === 'sonar') {
      sfx.play('sonar');
      if (gauge) sonarSweep(gauge);
    } else if (e.t === 'clear') {
      sfx.play('clear');
    } else if (e.t === 'won') {
      sfx.play('won');
      finishDive();
    } else if (e.t === 'lost') {
      sfx.play('lost');
      shake(view.root, 'big');
      finishDive();
    }
  }
}

function finishDive(): void {
  // Every peer reaches the summary, whatever ended their round.
  setTimeout(() => showResults(), 700);
}

// ── results ─────────────────────────────────────────────────────────────────

let tallied = false;

function showResults(): void {
  if (!session) return showMenu();
  const s = session.state;
  screenState = 'results';
  setPlaying(false);
  countdown?.cancel();
  countdown = null;

  if (!tallied) {
    tallied = true;
    tally = { dives: tally.dives + 1, surfaced: tally.surfaced + (s.ending === 'surfaced' ? 1 : 0) };
    const key = `best:${s.modeId}`;
    if (s.level > store.get(key, 0)) store.set(key, s.level);
  }
  const best = Math.max(store.get(`best:${s.modeId}`, 0), s.level);

  const r = rounds?.state();
  const waiting =
    net && r
      ? `<p class="wait">${r.votes.length}/${r.present.length} ready${
          r.startsInMs != null ? ` · starting in ${Math.ceil(r.startsInMs / 1000)}s` : ''
        }</p>`
      : '';

  screen(
    `${renderResults({ state: s, myIndex: session.myIndex, best, tally })}
     <div class="res-actions">
       ${
         net
           ? `<button class="btn primary big again" type="button" ${r?.voted ? 'disabled' : ''}>
                ${r?.voted ? 'Waiting for the crew…' : 'Dive again'}
              </button>
              ${waiting}
              ${r?.isHost ? '<button class="btn go-now" type="button">Start now</button>' : ''}
              <button class="btn ghost to-lobby" type="button">Back to lobby</button>
              <button class="btn ghost to-menu" type="button">Leave room</button>`
           : `<button class="btn primary big again" type="button">Dive again</button>
              <button class="btn ghost to-menu" type="button">Menu</button>`
       }
     </div>`,
    'results-screen',
  );

  app.querySelector('.again')?.addEventListener('click', () => {
    sfx.play('select');
    tallied = false;
    if (net && rounds) {
      // A rematch NEVER touches the room — it is a vote plus a new round number.
      rounds.finish();
      rounds.vote();
      queueRender();
    } else {
      startSolo();
    }
  });
  app.querySelector('.go-now')?.addEventListener('click', () => {
    rounds?.finish();
    rounds?.go();
  });
  app.querySelector('.to-lobby')?.addEventListener('click', () => {
    tallied = false;
    rounds?.finish();
    showLobby();
  });
  app.querySelector('.to-menu')?.addEventListener('click', () => {
    tallied = false;
    if (net) void leaveRoom();
    else showMenu();
  });
}

// ── teardown ────────────────────────────────────────────────────────────────

window.addEventListener('pagehide', () => {
  session?.destroy();
  rounds?.destroy();
  void net?.leave();
});

// A tab returning from the background: repaint immediately rather than waiting
// for the next snapshot, so the gauge is never stale under the player's thumb.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) queueRender();
});

showMenu();

export { SONAR_HOLD_MS, MAX_DIVERS, type PeerId };
