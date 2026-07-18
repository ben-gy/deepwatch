/**
 * drag.test.ts — the one control, and the gesture split it rests on.
 *
 * Deepwatch puts BOTH of its actions on a single card: tap to surface, hold to
 * signal for sonar. That only works if a hold can never also resolve as a tap —
 * otherwise every sonar signal would surface a card on release, which is both
 * the wrong move and usually a misplay.
 *
 * classifyRelease is pure, so the decision is tested exhaustively here without
 * having to fake pointer timing.
 */

import { describe, expect, it } from 'vitest';
import { classifyRelease } from '../src/engine/drag';

const T = { tapSlop: 3, swipeDist: 50, swipeVel: 0.5, swipeMaxMs: 250 };

describe('classifyRelease', () => {
  it('calls a still release a tap', () => {
    expect(classifyRelease(0, 0, 90, false, T)).toEqual({ kind: 'tap' });
    expect(classifyRelease(2, 1, 120, true, T)).toEqual({ kind: 'tap' });
  });

  it('A HOLD IS NEVER A TAP, however it was released', () => {
    // The bug this prevents: releasing a sonar signal also surfacing the card.
    for (const [dx, dy, dt, dragging] of [
      [0, 0, 900, false],
      [2, 2, 1500, false],
      [80, 0, 120, true],
      [0, 200, 3000, true],
    ] as const) {
      expect(classifyRelease(dx, dy, dt, dragging, T, true)).toEqual({ kind: 'hold' });
    }
  });

  it('still classifies normally when nothing was held', () => {
    expect(classifyRelease(0, 0, 900, false, T, false)).toEqual({ kind: 'tap' });
  });

  it('treats a fast far flick as a swipe, on the dominant axis', () => {
    expect(classifyRelease(80, 5, 100, true, T)).toEqual({ kind: 'swipe', dir: 'right' });
    expect(classifyRelease(-80, 5, 100, true, T)).toEqual({ kind: 'swipe', dir: 'left' });
    expect(classifyRelease(5, 80, 100, true, T)).toEqual({ kind: 'swipe', dir: 'down' });
    expect(classifyRelease(5, -80, 100, true, T)).toEqual({ kind: 'swipe', dir: 'up' });
  });

  it('treats a slow long move as a drag, not a swipe', () => {
    expect(classifyRelease(80, 0, 900, true, T)).toEqual({ kind: 'drag' });
  });

  it('keeps tap first-class right up to the slop boundary', () => {
    expect(classifyRelease(3, 0, 100, true, T).kind).toBe('tap');
    expect(classifyRelease(4, 0, 900, true, T).kind).toBe('drag');
  });
});
