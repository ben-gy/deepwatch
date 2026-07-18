/**
 * tuning.ts — the constants the dive's difficulty actually hangs on.
 *
 * These are gathered in one file because tests/balance.test.ts pins several of
 * them by name. A constant that the difficulty curve depends on and that no test
 * mentions is a constant someone will "clean up" later and silently break the
 * game with.
 */

/** All divers must hold together for this long to spend a sonar ping. */
export const SONAR_HOLD_MS = 700;

/** After a tide surge, the tide refills to this fraction — pressure, not a reset. */
export const TIDE_REFUND = 0.5;

/**
 * How long a diver waits per unit of depth-gap, as a fraction of the level's
 * tide. A diver holding a card the full depth of the deck above the floor would
 * wait TENSION_K of the whole tide before releasing it.
 *
 * This is what makes the read *work*: waiting time is proportional to how deep
 * your card is, so silence itself carries the information. Scaling it off the
 * tide (not a fixed ms) is why the same rule holds in a 46s Shallows level and a
 * frantic 18s Abyss one.
 */
export const TENSION_K = 1.35;

/**
 * Human sloppiness, in two parts, and the split is load-bearing.
 *
 * JITTER is proportional error (Weber's law: a long wait is judged less
 * precisely). JITTER_MS is a flat reaction-time error that does not care how
 * long you have been waiting.
 *
 * The first build had ONLY the proportional term, and it made the game
 * un-tunable in a way that took the sim three refuted hypotheses to expose. With
 * purely proportional error a misorder needs d2/d1 < (1+J*e1)/(1+J*e2) — a pure
 * RATIO. Every absolute quantity cancels: TENSION_K cancels, the tide length
 * cancels, and the depth of the deck cancels. That is why widening the deck did
 * nothing at all (a party-size sweep from 1x to 2.8x moved four-diver Trench
 * from 15% to 8%, i.e. noise), and why no amount of deck design could ever have
 * fixed it. The flat term is what gives separation in TIME meaning, and with it
 * the tide budget below becomes a real lever.
 *
 * JITTER is also the one knob that survives every rescaling — it is a ratio, so
 * it is the difficulty lever when the tide length is set by PLAYABILITY rather
 * than by balance. It was raised from 0.12 to 0.44 for exactly that reason: the
 * first playable build ran a Trench level 1 in 6.3 seconds, and a real person
 * watching the gauge could not get a single tap in before the bots had cleared
 * the level and the tide had force-surfaced both their cards. The balance sim
 * could never have caught that — its "human" is a bot with instant perception —
 * so the tide was slowed to human speed (level 1 now runs 9-22s, a whole dive
 * 5-7 minutes) and this was raised until the curve came back. ±44% on a judged
 * interval is about right for a person estimating seconds without a clock.
 *
 * Pinned by tests/balance.test.ts. Do not tune either without re-running the sim.
 */
export const JITTER = 0.44;
export const JITTER_MS = 900;

/**
 * As the tide runs down a diver stops waiting politely. The cap scales with how
 * deep their card is, so SHALLOW cards flush first and the end-of-level scramble
 * mostly resolves in the right order instead of being a coin flip.
 */
export const RUSH_MIN = 0.25;
export const RUSH_SPAN = 0.65;

/**
 * A diver signals for sonar while its own card sits closer to the floor than
 * this multiple of the EXPECTED gap between consecutive cards still in play.
 *
 * Measured against the expected gap rather than a fixed slice of the deck, and
 * that is what finally made the mechanic pay. A fixed fraction is wrong at both
 * ends of a level: early on, with a dozen cards still out, everything is inside
 * it and charges get burned on nothing; late on, with three cards left and huge
 * gaps, nothing ever is. The expected gap — (deck remaining) / (cards still
 * held), all of it public information — self-corrects for both, and for level
 * size and party size at no extra cost.
 *
 * Two earlier rules failed and both are worth remembering. "I hold a deep card
 * and the tide is half gone" measured patience, not danger: 7% finish with sonar
 * against 8% without, so the crew's signature mechanic was worse than not having
 * it. "I am overdue" was strictly unsatisfiable — being past your wait is
 * exactly the condition that makes you play, so the signal could never fire and
 * pings dropped to literally zero per run.
 *
 * What works is the opposite of both: signal when you are in DANGER, and let the
 * unanimity requirement do the detecting. No diver can see whether anyone is
 * closer to the floor than they are, but a ping that only fires when everyone is
 * signalling fires exactly when everyone is close — which is the cluster.
 */
export const SONAR_DANGER_K = 0.5;

/**
 * How long a diver will hold a signal before giving up and playing normally.
 * Without it, one nervous diver stalls the whole crew waiting for a consensus
 * that is never coming, and the tide eats them for it.
 *
 * MUST STAY COMFORTABLY ABOVE SONAR_HOLD_MS, and the sim is emphatic about it:
 * at 400ms against a 700ms hold the crew pays the full hesitation cost and can
 * never physically reach the ping, which scored 1% against 37% for having no
 * sonar at all — strictly worse than deleting the mechanic. At 800ms it scored
 * 57%. There is a test asserting this ordering, because the failure is silent.
 */
export const SONAR_PATIENCE_MS = 800;

/**
 * How much looser a diver's threshold is for JOINING a signal someone else has
 * already started, relative to starting one. Well above 1: the whole point is
 * that a signal in progress is evidence you cannot get any other way.
 */
export const JOIN_K = 4;
