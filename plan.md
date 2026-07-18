# Game Plan: Deepwatch

## Overview
- **Name:** Deepwatch
- **Repo name:** deepwatch
- **Tagline:** A silent co-op dive — surface the deep in order, without saying a word.
- **Genre (directory category):** card

## Core Loop
Your crew holds a hand of deep-sea creatures. Together you must surface them onto
one shared line **from shallowest to deepest** — and there is no printed number
anywhere and no way to talk. Each card is a silhouette hanging on a depth gauge;
its height *is* its depth, read by eye, not by digit.

So the only information you have about anyone else's hand is **who hasn't played
yet, and how long they've been not-playing.** Hold your card while the tide
climbs; release when it feels like nothing shallower is left below you. Surface
out of order and everything shallower than what you played gets dredged up
face-up and the crew burns one of a few shared **air tanks**.

Clear every card in the level in order → next level, one card deeper for
everyone. Run out of air tanks → the dive ends. Clear the final level → you
surfaced.

Two levers keep it from being pure nerve:
- **Sonar ping** — a shared charge everyone must *hold in unison* to spend. It
  forces every diver to discard their single shallowest card face-up, defusing a
  cluster of near-misses. Spending it takes wordless agreement, which is the
  whole game in miniature.
- **The rising tide** — a per-level clock that shrinks every level. When it tops
  out you lose a tank and the shallowest card in play is dragged up for you. Late
  levels are frantic; it also guarantees every run terminates.

**Win:** clear the final level. **Lose:** air tanks hit zero.

## Controls
One target, two gestures, entirely in the lower thumb zone. Never a D-pad —
this is a card game (principle #19 → `drag.ts` tap/press classifier).

- **Desktop:** `Space` (or click the card) = surface. Hold `S` (or press-and-hold
  the card) = signal for sonar. `Esc` = pause.
- **Mobile:** your shallowest card is a large card at the bottom of the screen.
  **Tap it** to surface (< 3px release, first-class action). **Press and hold it**
  past 700ms to signal for sonar — a ring fills around the card so the gesture is
  legible, and the ping only fires while *every* diver is holding at once. A hold
  never surfaces the card, so an over-long tap is visibly a sonar signal, not a
  misplay.

## Multiplayer
- **Mode:** live P2P (plus fully-featured solo against AI divers).
- **Shape:** **co-op** — the crew against the deck and the tide. Chosen over
  versus because the entire mechanic is *reading your teammates' silence*; the
  moment there is a winner, the incentive flips to letting someone else eat the
  mistake, which kills the only thing the game is about. Shared-world doesn't fit
  either: the tension needs a shared fate (the air tanks) to bite.
- **If co-op:** the opponent is the **card distribution and the tide clock**.
  Players share one fate — tanks are a single shared pool and a wipe ends the run
  for everyone. Nothing can be soloed: every diver holds cards only they can see,
  so the run physically cannot advance without each of them making a judgement
  call. Tension comes from *not being able to coordinate*, not from beating
  anyone.
- **Players:** 2–4. **Topology:** host-authoritative star.
  - Peer → host on `act`: `{t:'play'}` / `{t:'son', on:boolean}`. That's it — a
    release timestamp and a hold flag, **never a card value**.
  - Host → all on `snap` at 10Hz: level, surfaced line, per-diver hand *counts*,
    tanks, pings, tide, phase. Hand contents are never broadcast.
  - Host → each peer on `hand`: that peer's own cards only.
  - **By design there is no chat channel and no table-talk of any kind.**
  - Room entry: `createRoomEntry` (create a room **or** type a code). Invite link
    is a convenience, never the only way in.
  - **Late joiner:** spectates the current level, deals in at the next round.
  - **Peer leaves:** their remaining cards are dredged up face-up and the level
    continues — a loss of information, never a deadlock.
- **Host leaves → takeover.** Every peer can re-derive the full deal from
  `(seed, level, frozen roster)` via `rng.ts`, and the surfaced/discarded lists
  ride in every snapshot — so the authoritative state is fully reconstructible
  from the last snapshot plus the seed. `onHostChange` calls `Deep.takeOver()`:
  the survivor adopts its last snapshot, resumes the host-only tide/snapshot
  `setInterval`s, and the run stays finishable. Proven by `tests/takeover.test.ts`
  and by the manual host-leave smoke test.
  - *Honest consequence, disclosed in About:* because the deal is derivable from
    the shared seed, a determined player could read the table. This is a game of
    trust between friends, like a real card table nobody peeks at.
- **Countdown:** 3-2-1-DIVE with audio (`src/countdown.ts`) between the host's
  start arriving and the level actually running.

### End of round → rematch (MANDATORY)
"Play again" **never touches the room.** One `Net` for the session; rounds are
versioned inside it by `patterns/rematch.ts` (`createRounds`), which broadcasts a
fresh seed and the frozen roster so every peer indexes divers identically.

- **Waiting:** the summary shows who has readied up and a **visible countdown**
  (`state().startsInMs`) to the auto-start — never a silent unanimity wait.
- **Someone declines / closes the tab:** quorum + grace starts the round without
  them; the host can always **force start**.
- **Host leaves at the summary:** the promoted peer runs the rematch and inherits
  no tally (`rematch.ts` resyncs).
- **Persists across rounds:** a running **dive tally** — deepest level reached and
  runs completed by this crew.
- "Back to lobby" (does not leave the room) and "Menu" are both always offered.

### Everyone's result, every time (principle #9, co-op inversion)
The summary leads with the **shared** outcome — how deep the crew got and exactly
what ended the run — then a **per-diver contribution** breakdown: cards surfaced,
clean reads, and mistakes caused. Explicitly *not* a leaderboard: in a co-op game
ranking teammates rewards hogging, so contribution is shown as a share of the
dive, not a score. It also reveals **the cards nobody could see** — every hand at
the moment the run ended, so you can finally find out how close that call was.
Every peer reaches this screen, including one whose round ended early.

## Juice Plan
- **Sound** (`src/sound.ts`, procedural): `dive` (level start), `surface` (a
  rising bubble-blip whose pitch tracks the card's depth — so the *line itself*
  plays a melody when the crew is reading well), `miss` (a dull hull-clang +
  noise), `tank` (air hiss on losing one), `sonar` (a long clean ping sweep),
  `charge` (rising tone while the sonar ring fills), `clear`, `won`, `lost`,
  plus the countdown beats.
- **Screen shake** on a mistake and on a tide surge (skipped under
  `prefers-reduced-motion`).
- **Particles:** bubble trail rising off a surfaced card; a burst of silt on a
  mistake; an expanding sonar ring across the whole gauge on a ping.
- **Tweens:** a surfaced card *rises* up the gauge into the line (400ms ease-out)
  rather than teleporting; the tide bar drains continuously; the sonar ring fills
  with the hold.
- **The gauge breathes** — a slow caustic gradient so the screen is alive while
  everyone is frozen, which is most of the game.

## Style Direction
**Vibe:** cozy-dread deep sea — quiet, dark, bioluminescent.
**Palette:** abyss navy `#05141f` ground, `#0d2436` panels, **cyan `#4dd6e8`**
(sonar / your card), **amber `#f0b429`** (air tanks, tide warning), **coral
`#f2705d`** (mistakes), **sea-green `#6ee7b7`** (clean surface), pale
`#e8f4f8` text. Cyan/amber/coral is a blue–orange–red split that survives all
three common CVD types; every state is *additionally* carried by icon, motion and
text, never by hue alone.
**Theme:** dark (it's the deep).
**Reference feel:** the hush of a well-made co-op board game; Abzû's palette.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** **DOM/CSS** — the depth gauge, silhouettes and card are crisp text
  and shapes with trivial responsive layout and real hit targets; a canvas would
  buy nothing here. (Particles are cheap absolutely-positioned divs.)
- **Engine modules copied from patterns/:** net, rematch, lobby, rng, storage,
  mobile (+ mobile.css), identity, drag. Plus local `sound.ts`, `countdown.ts`.
- **Persistence:** localStorage via `storage.ts` — mute, seen-how-to-play, player
  name, best depth per mode.
- **Core is pure and tick-driven** (`step(state, dtMs)`, `playCard(state, i)`) so
  the whole game runs headless in the balance sim at thousands of runs/second.

## Modes (`src/modes.ts` — 3, with genuine spread)
| Mode | Levels | Tanks | Pings | Deck | Tide base / decay |
|---|---|---|---|---|---|
| **Shallows** | 8 | 4 | 2 | 1–100 | 46s × 0.93 |
| **Trench** | 10 | 3 | 2 | 1–100 | 38s × 0.90 |
| **Abyss** | 12 | 3 | 1 | **1–60** | 32s × 0.88 |

Abyss's change is **spatial, not a dial**: squeezing the same number of cards into
a 60-deep range makes cards sit 1–2 apart constantly, so near-misses are the
norm and the read stops being about patience and starts being about nerve.
These numbers are the **starting** point — the balance sim referees them
(principle #18) and is written before any tuning.

## Balance (MANDATORY — `tests/balance.test.ts`, co-op difficulty curve)
The opponent is the ramp, so it gets the same rigour a versus game's seats get.
Hundreds of fixed-seed AI-table runs per mode, asserting the *shape*:
- **P(clear level N)** is a smooth descending ramp — early levels near-certain,
  no cliff between adjacent levels, final level neither 0% nor a formality.
- **Median air tanks remaining** stays in a tense band (never untouched, never
  always-zero).
- **Every run terminates** inside a bounded step count (the tide guarantees it —
  pinned by a test).
- **Mode ordering holds:** P(finish Shallows) > P(finish Trench) > P(finish Abyss).
- **Sonar earns its slot:** a crew with pings clears measurably more than the same
  seeds with pings disabled. If it doesn't, the mechanic is decoration and goes.
- **Party size is playable at 2, 3 and 4** — more divers means more hidden hands,
  which must make it harder in a graded way, not invert or wall it.

The bot is deliberately **honest**: it sees only its own hand plus public state,
so the sim measures the real game. Its release rule is the human one — wait time
proportional to the gap between its shallowest card and the current floor —
jittered. **That jitter constant is the primary difficulty lever** and is pinned
by its own assertion.

## Non-Goals
- No chat, emotes, or any table-talk channel. Ever. That is the design.
- No public matchmaking / noticeboard this run (a silent trust game wants
  friends, not strangers; and it keeps the WebRTC IP surface to invited rooms).
- No account, no cloud leaderboard, no daily seed this run.

## How To Play (player-facing copy)
> Your crew surfaces creatures onto one line, **shallowest first** — but you can't
> see anyone else's cards and **you can't talk.**
> Your card's height on the gauge is how deep it is. Hold it while the tide
> climbs; release when you think nothing shallower is left below you.
> Surface out of order and the crew loses an **air tank**. Out of air, the dive
> ends.
> Stuck? Everyone **press and hold together** to spend a **sonar ping** — it
> discards each diver's shallowest card, face-up.
