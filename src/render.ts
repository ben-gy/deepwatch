/**
 * render.ts — the dive screen.
 *
 * The depth gauge IS the game's interface. A card carries no number anywhere;
 * its height on the gauge is its depth, and you judge "how deep is mine, really?"
 * by eye against the shaded band of what the crew has already surfaced. Reading
 * that band against your own marker is the entire skill.
 *
 * The DOM is built ONCE per level and then mutated in place. Rebuilding it from
 * a template string each frame would be simpler and would also destroy the big
 * card element mid-gesture — which silently cancels the pointer capture and eats
 * the sonar hold every time the state changed under a resting thumb.
 */

import { modeOfState, tideFrac, type DiveState } from './game';

/**
 * Six silhouettes, picked by how deep the card is, in 64-unit space. Shallow
 * water gets drifting, harmless shapes; the deep gets teeth. It is decoration
 * with a job: after a few dives the shape alone tells you roughly how deep you
 * are holding, before you have consciously read the gauge.
 */
const CREATURES: string[] = [
  // jellyfish
  '<path d="M32 18c9 0 15 7 15 14H17c0-7 6-14 15-14z"/><path d="M22 34c0 6-2 8-2 12M28 34c0 7-1 9-1 13M36 34c0 7 1 9 1 13M42 34c0 6 2 8 2 12" stroke-width="2.4" fill="none" stroke="currentColor" stroke-linecap="round"/>',
  // ray
  '<path d="M32 20c10 0 22 8 26 16-8 4-16 6-26 6s-18-2-26-6c4-8 16-16 26-16z"/><path d="M32 42v14" stroke-width="2.6" fill="none" stroke="currentColor" stroke-linecap="round"/>',
  // squid
  '<ellipse cx="32" cy="24" rx="10" ry="13"/><path d="M24 36c-1 8-4 11-6 14M29 38c-1 8-2 11-3 14M35 38c1 8 2 11 3 14M40 36c1 8 4 11 6 14" stroke-width="2.4" fill="none" stroke="currentColor" stroke-linecap="round"/>',
  // eel
  '<path d="M12 44c8 0 8-12 16-12s8 12 16 12 8-10 8-10" stroke-width="6" fill="none" stroke="currentColor" stroke-linecap="round"/><circle cx="50" cy="32" r="2.2" fill="var(--abyss)"/>',
  // anglerfish
  '<path d="M20 34c0-8 8-13 16-13s16 5 16 13-8 13-16 13-16-5-16-13z"/><path d="M36 21c0-6-4-9-8-9" stroke-width="2.2" fill="none" stroke="currentColor"/><circle cx="28" cy="12" r="3.4"/><path d="M20 34l-8-6v12l8-6z"/><path d="M26 38l3 4 3-4 3 4 3-4" stroke-width="2" fill="none" stroke="var(--abyss)"/>',
  // gulper
  '<path d="M14 32l30-11v22L14 32z"/><path d="M44 26c6 1 8 4 8 6s-2 5-8 6" stroke-width="3" fill="none" stroke="currentColor"/><path d="M20 30l4 2-4 2M28 28l4 4-4 4" stroke-width="1.8" fill="none" stroke="var(--abyss)"/>',
];

export function creatureFor(depth: number, deckMax: number): string {
  const band = Math.min(CREATURES.length - 1, Math.floor((depth / Math.max(1, deckMax)) * CREATURES.length));
  return CREATURES[band];
}

const svg = (body: string, cls: string): string =>
  `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" fill="currentColor">${body}</svg>`;

const pctOf = (depth: number, deckMax: number): number =>
  Math.max(0, Math.min(100, (depth / Math.max(1, deckMax)) * 100));

export interface DiveViewOpts {
  /** Index of the local diver, or -1 while spectating. */
  myIndex: number;
  onPlay: () => void;
  onSignal: (on: boolean) => void;
}

export class DiveView {
  readonly root: HTMLElement;
  private readonly opts: DiveViewOpts;

  private elLevel!: HTMLElement;
  private elTanks!: HTMLElement;
  private elPings!: HTMLElement;
  private elTide!: HTMLElement;
  private elDone!: HTMLElement;
  private elMarks!: HTMLElement;
  private elMine!: HTMLElement;
  private elCrew!: HTMLElement;
  private elCard!: HTMLButtonElement;
  private elCardArt!: HTMLElement;
  private elRing!: HTMLElement;
  private elHand!: HTMLElement;
  private elHint!: HTMLElement;

  private marked = 0;
  private lastCard = -1;
  private lastLevel = -1;

  constructor(opts: DiveViewOpts) {
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'dive';
    this.build();
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="hud">
        <span class="hud-level" aria-live="polite"></span>
        <span class="hud-air" title="Air tanks"></span>
        <span class="hud-ping" title="Sonar charges"></span>
      </div>
      <div class="tide" role="img" aria-label="Rising tide">
        <div class="tide-fill"></div>
      </div>
      <div class="gauge">
        <div class="gauge-done"></div>
        <div class="gauge-marks"></div>
        <div class="gauge-mine" hidden></div>
        <span class="gauge-cap gauge-cap-top">surface</span>
        <span class="gauge-cap gauge-cap-bot">the deep</span>
      </div>
      <div class="crew"></div>
      <div class="hand" aria-label="Your remaining cards"></div>
      <div class="cardwrap">
        <button class="card" type="button" aria-label="Your shallowest card — tap to surface, hold to signal for sonar">
          <span class="card-ring"></span>
          <span class="card-art"></span>
        </button>
      </div>
      <p class="hint"></p>`;

    const q = <T extends HTMLElement>(sel: string): T => this.root.querySelector<T>(sel)!;
    this.elLevel = q('.hud-level');
    this.elTanks = q('.hud-air');
    this.elPings = q('.hud-ping');
    this.elTide = q('.tide-fill');
    this.elDone = q('.gauge-done');
    this.elMarks = q('.gauge-marks');
    this.elMine = q('.gauge-mine');
    this.elCrew = q('.crew');
    this.elCard = q<HTMLButtonElement>('.card');
    this.elCardArt = q('.card-art');
    this.elRing = q('.card-ring');
    this.elHand = q('.hand');
    this.elHint = q('.hint');
  }

  /** Called by main.ts, which owns the gesture wiring (drag.ts). */
  get cardEl(): HTMLElement {
    return this.elCard;
  }

  /** Drop every marker — a new level starts from an empty line. */
  private resetLevel(): void {
    this.elMarks.innerHTML = '';
    this.marked = 0;
    this.lastCard = -1;
  }

  update(s: DiveState, awaiting: boolean): void {
    if (s.level !== this.lastLevel) {
      this.lastLevel = s.level;
      this.resetLevel();
    }

    this.elLevel.textContent = `Level ${s.level} / ${s.levels}`;

    // Air and sonar are drawn as pips, never as bare numbers: the whole game is
    // "read it at a glance", and that has to include how much trouble you're in.
    this.elTanks.innerHTML = Array.from({ length: s.tanksMax }, (_, i) =>
      `<i class="pip air${i < s.tanks ? '' : ' spent'}"></i>`,
    ).join('');
    this.elPings.innerHTML =
      s.pings > 0
        ? Array.from({ length: s.pings }, () => '<i class="pip ping"></i>').join('')
        : '<i class="pip ping spent"></i>';

    const frac = tideFrac(s);
    this.elTide.style.width = `${frac * 100}%`;
    this.elTide.classList.toggle('urgent', frac < 0.25);

    this.elDone.style.height = `${pctOf(s.floor, s.deckMax)}%`;

    // Markers are appended, never re-rendered, so their rise animation plays
    // once and a repaint mid-level cannot restart every bubble on screen.
    const all = [
      ...s.surfaced.map((c) => ({ depth: c.depth, kind: c.forced ? 'tide' : 'up' })),
      ...s.dredged.map((c) => ({ depth: c.depth, kind: c.cause === 'sonar' ? 'sonar' : 'lost' })),
    ];
    for (let i = this.marked; i < all.length; i++) {
      const m = document.createElement('i');
      m.className = `mark ${all[i].kind}`;
      m.style.top = `${pctOf(all[i].depth, s.deckMax)}%`;
      this.elMarks.appendChild(m);
    }
    this.marked = all.length;

    const hand = this.opts.myIndex >= 0 ? (s.hands[this.opts.myIndex] ?? []) : [];
    const mine = hand[0];

    if (mine == null) {
      this.elMine.hidden = true;
      this.elCard.classList.add('empty');
      this.elCardArt.innerHTML = '';
    } else {
      this.elMine.hidden = false;
      this.elMine.style.top = `${pctOf(mine, s.deckMax)}%`;
      this.elCard.classList.remove('empty');
      if (mine !== this.lastCard) {
        this.lastCard = mine;
        // The card is its own little depth gauge: the creature hangs at the
        // height that IS its depth. No digits, anywhere.
        this.elCardArt.innerHTML = `
          <span class="card-depth" style="top:${pctOf(mine, s.deckMax)}%">
            ${svg(creatureFor(mine, s.deckMax), 'creature')}
          </span>`;
      }
    }
    this.elCard.classList.toggle('awaiting', awaiting);
    this.elCard.disabled = mine == null || s.phase !== 'diving';

    // The hand strip. Abyss hides everything past your next card, which is the
    // whole point of that mode — you cannot plan, only react.
    const hidden = modeOfState(s).hiddenHand;
    this.elHand.innerHTML = hand
      .slice(1)
      .map((d) =>
        hidden
          ? '<i class="held unknown"></i>'
          : `<i class="held" style="--d:${pctOf(d, s.deckMax)}%"></i>`,
      )
      .join('');

    this.elCrew.innerHTML = s.divers
      .map((d, i) => {
        const n = s.hands[i]?.length ?? 0;
        const me = i === this.opts.myIndex;
        return `<span class="diver${me ? ' me' : ''}${n === 0 ? ' done' : ''}${
          s.holding[i] ? ' holding' : ''
        }">
          <span class="diver-name">${escapeHtml(d.name)}${d.bot ? ' <i class="bot">AI</i>' : ''}</span>
          <span class="diver-count">${n}</span>
        </span>`;
      })
      .join('');

    const holdFrac = Math.max(0, Math.min(1, s.holdMs / 700));
    this.elRing.style.setProperty('--fill', `${holdFrac * 100}%`);
    this.elRing.classList.toggle('on', s.holding[this.opts.myIndex] === true);

    this.elHint.textContent = this.hintFor(s, mine == null);
  }

  private hintFor(s: DiveState, empty: boolean): string {
    if (s.phase !== 'diving') return '';
    if (empty) return 'Your hand is clear — watch the others.';
    if (s.pings > 0 && s.holding.some((h) => h)) return 'Someone is signalling for sonar…';
    return 'Tap to surface · hold to signal for sonar';
  }

  destroy(): void {
    this.root.remove();
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
