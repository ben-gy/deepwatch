/**
 * room-code.test.ts — a hand-typed code must reach the same room as the link.
 *
 * People paste codes into chat, read them aloud, and type them on a different
 * device through an autocapitalizing keyboard. If "k7qp" and "K7QP" resolve to
 * different Trystero rooms, both players sit in what each believes is the same
 * room, alone, forever — and the UI has nothing to show them that is wrong.
 */

import { describe, expect, it } from 'vitest';
import { mintCode, normalizeRoomCode } from '@ben-gy/game-engine/lobby';

describe('normalizeRoomCode', () => {
  it('canonicalises what a human actually types', () => {
    for (const typed of ['k7qp', 'K7QP', ' k7qp ', 'k7-qp', 'K7 QP', 'k7qp.', 'K7QP\n']) {
      expect(normalizeRoomCode(typed), `"${typed}" must reach room K7QP`).toBe('K7QP');
    }
  });

  it('strips the punctuation people put between the pairs', () => {
    expect(normalizeRoomCode('k7—qp')).toBe('K7QP');
    expect(normalizeRoomCode('"K7QP"')).toBe('K7QP');
    expect(normalizeRoomCode('  k 7 - q p  ')).toBe('K7QP');
  });

  it('is idempotent, so a normalised code survives a second pass', () => {
    const code = normalizeRoomCode('k7-qp');
    expect(normalizeRoomCode(code)).toBe(code);
  });

  it('agrees with the code the invite link carries', () => {
    for (let i = 0; i < 200; i++) {
      const minted = mintCode();
      expect(normalizeRoomCode(minted)).toBe(minted);
      expect(normalizeRoomCode(minted.toLowerCase())).toBe(minted);
      expect(normalizeRoomCode(` ${minted.toLowerCase()} `)).toBe(minted);
    }
  });

  it('caps length so a pasted URL cannot become a room id', () => {
    expect(normalizeRoomCode('https://deepwatch.benrichardson.dev/?room=K7QP').length).toBe(8);
    expect(normalizeRoomCode('AAAAAAAAAAAAAAAA')).toBe('AAAAAAAA');
    expect(normalizeRoomCode('k7qp').length).toBe(4);
  });

  it('gives back an empty string for nothing usable', () => {
    expect(normalizeRoomCode('')).toBe('');
    expect(normalizeRoomCode('---')).toBe('');
    expect(normalizeRoomCode('   ')).toBe('');
  });
});

describe('mintCode', () => {
  it('makes a 4-character code from an unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const c = mintCode();
      expect(c).toHaveLength(4);
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });

  it('does not keep handing out the same code', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintCode()));
    expect(seen.size).toBeGreaterThan(150);
  });
});
