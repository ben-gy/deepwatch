/**
 * fx.ts — the juice. Bubbles, silt, shake, sonar sweep.
 *
 * All of it degrades to nothing under `prefers-reduced-motion`, which is checked
 * live rather than once at boot so a player changing the OS setting mid-dive is
 * respected without a reload.
 *
 * Particles are plain absolutely-positioned spans that remove themselves on
 * animationend. No canvas, no rAF loop, nothing to leak if a screen is torn down
 * mid-animation.
 */

const reduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function shake(el: HTMLElement, strength: 'small' | 'big' = 'small'): void {
  if (reduced()) return;
  const cls = strength === 'big' ? 'shake-big' : 'shake-small';
  el.classList.remove('shake-small', 'shake-big');
  // Force a reflow so re-adding the class restarts the animation when two
  // misplays land back to back.
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), strength === 'big' ? 460 : 280);
}

/** A trail of bubbles rising from a point, as a card breaks the surface. */
export function bubbles(host: HTMLElement, topPct: number, count = 7): void {
  if (reduced()) return;
  for (let i = 0; i < count; i++) {
    const b = document.createElement('span');
    b.className = 'bubble';
    b.style.top = `${topPct}%`;
    b.style.left = `${18 + Math.random() * 64}%`;
    b.style.setProperty('--r', `${3 + Math.random() * 6}px`);
    b.style.setProperty('--dur', `${900 + Math.random() * 700}ms`);
    b.style.animationDelay = `${i * 45}ms`;
    b.addEventListener('animationend', () => b.remove(), { once: true });
    host.appendChild(b);
  }
}

/** A burst of silt where a card was dredged up. */
export function silt(host: HTMLElement, topPct: number): void {
  if (reduced()) return;
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('span');
    p.className = 'silt';
    p.style.top = `${topPct}%`;
    p.style.left = '50%';
    p.style.setProperty('--dx', `${(Math.random() * 2 - 1) * 90}px`);
    p.style.setProperty('--dy', `${(Math.random() * 2 - 1) * 60}px`);
    p.addEventListener('animationend', () => p.remove(), { once: true });
    host.appendChild(p);
  }
}

/** The sonar ring sweeping the whole gauge. */
export function sonarSweep(host: HTMLElement): void {
  const r = document.createElement('span');
  r.className = 'sweep';
  r.addEventListener('animationend', () => r.remove(), { once: true });
  host.appendChild(r);
  // Even with reduced motion the sweep still appears; it is the confirmation
  // that a shared, deliberate action landed, so removing it entirely would cost
  // information rather than just polish. It simply does not travel.
  if (reduced()) setTimeout(() => r.remove(), 200);
}
