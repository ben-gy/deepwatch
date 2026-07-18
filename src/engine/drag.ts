/**
 * drag.ts — one pointer-gesture classifier for DOM cards, tiles and handles.
 *
 * Copied from patterns/drag.ts and EXTENDED with a fourth gesture, HOLD, which
 * Deepwatch's single control needs (see below). Everything else — the
 * thresholds, the tap-stays-first-class rule, the Pointer Events plumbing — is
 * the shared pattern unchanged.
 *
 *   TAP    — released within TAP_SLOP of where it started → the element's normal
 *            activate action. Tap ALWAYS stays a first-class fallback.
 *   HOLD   — held past HOLD_MS without moving past the drag slop → onHoldStart,
 *            then onHoldEnd on release. **A hold is NOT a tap**: the release
 *            that ends it must not also fire the activate action, or every
 *            sonar signal in Deepwatch would surface a card by accident.
 *   DRAG   — moved past DRAG_SLOP → onDragStart, then onDragMove(dx,dy) until
 *            release → onDrop(dx,dy).
 *   SWIPE  — a fast flick (far enough, quick enough) → onSwipe(dir). Direction is
 *            locked to the dominant axis. A swipe suppresses the drop.
 *
 * Thresholds are the verified defaults from patterns/MOBILE_CONTROLS.md
 * (@use-gesture / Android touch-slop). The element must set `touch-action: none`
 * (and ideally `user-select:none`) or the page scroll steals the gesture.
 */

export type SwipeDir = 'up' | 'down' | 'left' | 'right';

export interface GestureThresholds {
  /** Release within this of the start = tap. */
  tapSlop: number;
  /** Min flick distance. */
  swipeDist: number;
  /** Min flick speed (px/ms). */
  swipeVel: number;
  /** Slower than this ⇒ a drag, not a swipe (ms). */
  swipeMaxMs: number;
}

export type Gesture =
  | { kind: 'tap' }
  | { kind: 'hold' }
  | { kind: 'drag' }
  | { kind: 'swipe'; dir: SwipeDir };

/**
 * Classify a released pointer gesture from its total delta, duration, whether it
 * ever crossed the drag threshold, and whether it was promoted to a hold. Pure —
 * the single source of truth for the decision, so it can be tested exhaustively
 * without event timing.
 *
 * `held` is checked FIRST and unconditionally. Once a press has been recognised
 * as a hold the player has already seen the sonar ring filling; resolving that
 * same release as a tap as well would fire two different actions from one
 * gesture.
 */
export function classifyRelease(
  dx: number,
  dy: number,
  dt: number,
  dragging: boolean,
  t: GestureThresholds,
  held = false,
): Gesture {
  if (held) return { kind: 'hold' };
  if (!dragging) return { kind: 'tap' };
  const dist = Math.hypot(dx, dy);
  if (dist <= t.tapSlop) return { kind: 'tap' };
  const speed = dist / Math.max(dt, 1);
  if (dt < t.swipeMaxMs && (speed > t.swipeVel || dist > t.swipeDist)) {
    const dir: SwipeDir =
      Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    return { kind: 'swipe', dir };
  }
  return { kind: 'drag' };
}

export interface DragHandlers {
  /** Released without ever dragging or holding — the normal activate action. */
  onTap?: (e: PointerEvent) => void;
  /** Press passed holdMs without moving. */
  onHoldStart?: () => void;
  /** A hold ended (release or cancel). */
  onHoldEnd?: () => void;
  /** Crossed the drag threshold. */
  onDragStart?: (e: PointerEvent) => void;
  /** Total delta from the start point, every move while dragging. */
  onDragMove?: (dx: number, dy: number, e: PointerEvent) => void;
  /** Released after a (non-swipe) drag, with the final delta. */
  onDrop?: (dx: number, dy: number, e: PointerEvent) => void;
  /** A fast flick. If provided and matched, onDrop is NOT called. */
  onSwipe?: (dir: SwipeDir, dx: number, dy: number) => void;
  /** Pointer was cancelled mid-gesture (call, notification) — abort/snap back. */
  onCancel?: () => void;
}

export interface DragConfig extends DragHandlers {
  /** Release within this of the start = tap. Default 3px. */
  tapSlop?: number;
  /** Promote press→drag past this. Default 8px (touch) / 4px (mouse). */
  dragSlop?: number;
  /** Min flick distance. Default 50px. */
  swipeDist?: number;
  /** Min flick speed. Default 0.5 px/ms. */
  swipeVel?: number;
  /** Slower than this ⇒ a drag, not a swipe. Default 250ms. */
  swipeMaxMs?: number;
  /** Promote press→hold after this. Omit to disable the hold gesture. */
  holdMs?: number;
  /** setPointerCapture so an off-element drag still tracks. Default true. */
  capture?: boolean;
}

export interface Draggable {
  destroy(): void;
}

export function makeDraggable(el: HTMLElement, config: DragConfig): Draggable {
  const tapSlop = config.tapSlop ?? 3;
  const swipeDist = config.swipeDist ?? 50;
  const swipeVel = config.swipeVel ?? 0.5;
  const swipeMaxMs = config.swipeMaxMs ?? 250;
  const capture = config.capture ?? true;

  let id: number | null = null;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let dragging = false;
  let held = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  const dragSlopFor = (e: PointerEvent): number =>
    config.dragSlop ?? (e.pointerType === 'mouse' ? 4 : 8);
  let slop = 8;

  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  };

  /** Fire onHoldEnd exactly once per hold, whatever ended it. */
  const endHold = (): void => {
    clearHold();
    if (!held) return;
    held = false;
    config.onHoldEnd?.();
  };

  const onDown = (e: PointerEvent): void => {
    if (id !== null) return;
    id = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startT = performance.now();
    dragging = false;
    held = false;
    slop = dragSlopFor(e);
    if (capture) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (config.holdMs != null) {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        // A press that has already become a drag is not a hold.
        if (id === null || dragging) return;
        held = true;
        config.onHoldStart?.();
      }, config.holdMs);
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < slop) return;
      // Moving out of the hold cancels the pending promotion, but a hold already
      // in progress survives a wandering thumb — a finger resting on a card for
      // two seconds drifts, and losing the sonar signal to that would be cruel.
      if (!held) {
        clearHold();
        dragging = true;
        config.onDragStart?.(e);
      }
    }
    if (dragging) config.onDragMove?.(dx, dy, e);
    e.preventDefault(); // block native image/text drag & scroll during a drag
  };

  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    id = null;
    clearHold();
    if (capture) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dt = performance.now() - startT;

    const wasHeld = held;
    const g = classifyRelease(dx, dy, dt, dragging, { tapSlop, swipeDist, swipeVel, swipeMaxMs }, wasHeld);
    endHold();
    if (g.kind === 'hold') return; // onHoldEnd already fired; never also a tap
    if (g.kind === 'tap') config.onTap?.(e);
    else if (g.kind === 'swipe' && config.onSwipe) config.onSwipe(g.dir, dx, dy);
    else config.onDrop?.(dx, dy, e);
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    id = null;
    const wasDragging = dragging;
    dragging = false;
    // An interrupted hold must release the sonar signal, or a phone call would
    // leave this diver stuck "holding" forever and jam the ping for the crew.
    endHold();
    if (wasDragging) config.onCancel?.();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onPointerCancel);

  return {
    destroy() {
      clearHold();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}
