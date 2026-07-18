/**
 * results.ts — the end-of-dive summary.
 *
 * Principle #9, in its co-op form. This screen leads with the SHARED outcome —
 * how deep the crew got and precisely what ended the run — and only then breaks
 * down what each diver contributed. It is deliberately NOT a leaderboard: in a
 * co-operative game, ranking your teammates rewards hogging the thing that
 * scores, and here that would mean grabbing every easy card and leaving the
 * agonising ones to someone else. So contributions are shown as a share of the
 * dive, and "misplays" sit next to "cards surfaced" rather than being totalled
 * into a verdict.
 *
 * It also answers the question the whole game is built on withholding: it shows
 * EVERY HAND as it stood when the run ended. Finding out that the card you sat
 * on for nine seconds was two off the one that killed you is the payoff for a
 * round of pure silence.
 */

import { creatureFor, escapeHtml } from './render';
import type { DiveState } from './game';
import { modeOfState } from './game';

export interface ResultsOpts {
  state: DiveState;
  /** Index of the local diver, or -1 if they only watched. */
  myIndex: number;
  /** Deepest level this crew has ever reached, across the session. */
  best: number;
  /** Runs completed together this session. */
  tally: { dives: number; surfaced: number };
}

function endingLine(s: DiveState): { title: string; sub: string } {
  if (s.ending === 'surfaced') {
    return {
      title: 'You surfaced',
      sub: `The whole crew made it out of ${modeOfState(s).name} — all ${s.levels} levels, in silence.`,
    };
  }
  const last = s.dredged[s.dredged.length - 1];
  return {
    title: 'Out of air',
    sub: last
      ? `The dive ended on level ${s.level}. The last thing lost was a creature at depth ${last.depth}.`
      : `The dive ended on level ${s.level}.`,
  };
}

export function renderResults(opts: ResultsOpts): string {
  const s = opts.state;
  const { title, sub } = endingLine(s);
  const totalSurfaced = s.stats.reduce((t, st) => t + st.surfaced, 0) || 1;
  const misplays = s.stats.reduce((t, st) => t + st.misplays, 0);

  const contributions = s.divers
    .map((d, i) => {
      const st = s.stats[i];
      const share = Math.round((st.surfaced / totalSurfaced) * 100);
      return `<li class="res-diver${i === opts.myIndex ? ' me' : ''}">
        <span class="res-name">${escapeHtml(d.name)}${d.bot ? ' <i class="bot">AI</i>' : ''}${
          i === opts.myIndex ? ' <i class="you">you</i>' : ''
        }</span>
        <span class="res-bar"><i style="width:${share}%"></i></span>
        <span class="res-nums">
          <b>${st.surfaced}</b> surfaced
          <span class="res-clean">${st.clean} clean</span>
          ${st.misplays ? `<span class="res-miss">${st.misplays} misplay${st.misplays === 1 ? '' : 's'}</span>` : ''}
        </span>
      </li>`;
    })
    .join('');

  // What nobody could see. This is the whole reason to sit through the silence.
  const reveal = (s.finalHands ?? [])
    .map((hand, i) => {
      if (!hand.length) return '';
      const cards = hand
        .map(
          (depth) =>
            `<span class="rev-card" title="depth ${depth}">
               <svg viewBox="0 0 64 64" aria-hidden="true" fill="currentColor">${creatureFor(depth, s.deckMax)}</svg>
               <i>${depth}</i>
             </span>`,
        )
        .join('');
      return `<li><span class="rev-who">${escapeHtml(s.divers[i].name)}</span><span class="rev-cards">${cards}</span></li>`;
    })
    .filter(Boolean)
    .join('');

  return `
    <div class="results">
      <div class="res-head ${s.ending === 'surfaced' ? 'good' : 'bad'}">
        <h2>${title}</h2>
        <p>${sub}</p>
      </div>

      <div class="res-shared">
        <div class="res-stat"><b>${s.level}</b><span>level reached</span></div>
        <div class="res-stat"><b>${s.tanks}</b><span>air left</span></div>
        <div class="res-stat"><b>${misplays}</b><span>misplay${misplays === 1 ? '' : 's'}</span></div>
        <div class="res-stat"><b>${opts.best}</b><span>crew best</span></div>
      </div>

      <h3 class="res-sub">What the crew did</h3>
      <p class="res-note">Everyone's dive, not a scoreboard — you all breathed the same air.</p>
      <ul class="res-divers">${contributions}</ul>

      ${
        reveal
          ? `<h3 class="res-sub">What nobody could see</h3>
             <p class="res-note">The hands still held when the dive ended.</p>
             <ul class="res-reveal">${reveal}</ul>`
          : ''
      }

      ${
        opts.tally.dives > 1
          ? `<p class="res-tally">This crew: ${opts.tally.dives} dives, ${opts.tally.surfaced} surfaced.</p>`
          : ''
      }
    </div>`;
}
