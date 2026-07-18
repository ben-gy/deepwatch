# Deepwatch

**A silent co-op dive — surface the deep in order, without saying a word.**

🎮 Play: https://deepwatch.benrichardson.dev

## What it is

Your crew holds a hand of deep-sea creatures, and together you have to surface
them onto one shared line from shallowest to deepest. There are no numbers
anywhere — each card is a silhouette hanging on a depth gauge, and its height
*is* its depth. And you can't talk.

So the only information you have about anyone else's hand is **who hasn't played
yet, and how long they've been not-playing.** Hold your card while the tide
climbs. Release when it feels like nothing shallower is left below you. Get it
wrong and every shallower card in the crew comes up face-up, and you all lose one
of a few shared air tanks. Out of air, the dive ends.

That's the whole game, and it turns out to be almost unbearably tense. A diver
sitting perfectly still for nine seconds is *telling* you something. Two people
releasing at the same instant is a disaster you both saw coming and neither could
prevent. When it's stuck, everyone **presses and holds together** to spend a
sonar ping — a wordless agreement that discards each diver's shallowest card and
defuses the pile-up. Nobody scores. You all breathe the same air.

It's fully playable solo against AI divers who hesitate on a human curve, and
over a room link with two to four friends.

## How to play

- **Goal:** surface every card in the level in ascending depth. Clear all the
  levels to surface. Reach zero air tanks and the dive is over.
- **Mobile:** **tap** your card to surface it. **Press and hold** it to signal
  for sonar — the ping only fires while *every* diver is holding at once.
- **Desktop:** `Space` to surface, hold `S` to signal, `Esc` to step out.

Three dives, and they are genuinely different runs:

| Mode | Levels (2 divers) | Air | Sonar | Character |
|---|---|---|---|---|
| **Shallows** | 8 | 4 | 2 | A patient tide. Learn to read the silence. |
| **Trench** | 10 | 3 | 2 | The standard dive, clock closing. |
| **Abyss** | 12 | 3 | 1 | Crowded deck, and **you only ever see your next card**. |

A bigger crew dives *fewer* levels — every party size faces about the same total
number of cards, so four divers is a different shape of challenge rather than an
impossible one.

## Multiplayer

Live peer-to-peer for 2–4 divers, co-operative. Create a room or type a friend's
code; there is no server, no account and no lobby of strangers.

**There is no chat channel — not a muted one, there simply isn't one.** The
silence is the game.

Browsers connect directly over WebRTC; a free public signalling relay only
introduces them. Connecting shares your IP address with the people in your room,
which is exactly why rooms are invite-only.

Hands are never transmitted. Every peer derives the deal from one shared seed, so
if the host disconnects any survivor can take over instantly and the run stays
finishable. The honest consequence, also stated in-game: a determined player
could compute the table. It's a game for people who chose to play together — no
more peekable than a real card table nobody leans across.

## Tech

- Vite 6 + vanilla TypeScript
- DOM/CSS rendering (the depth gauge is the interface)
- Shared engine: Trystero P2P netcode, seeded RNG, pointer-gesture classifier,
  procedural Web Audio
- Vitest — 172 tests, including a co-op difficulty-curve simulation, P2P-sync
  determinism, host-transfer takeover and the full rematch lifecycle
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
page-view counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## License

MIT
