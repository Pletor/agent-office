import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { LOFT } from '../src/shared/layout.js';
import { BOSS_ATTENTION_BOARD, bossAttentionBoard } from '../src/client/features/bossattention/world.js';
import type { Site } from '../src/client/world/office/fixture.js';
import type { Interactable } from '../src/client/world/types.js';

test('boss board fits above the red couch and faces the accessible room side', () => {
  const interactables: Interactable[] = [];
  const built = bossAttentionBoard({ interactables } as Site);
  const board = built.handle!.bossAttentionBoard;
  const s = BOSS_ATTENTION_BOARD;
  assert.equal(s.z, (LOFT.minZ + LOFT.maxZ) / 2);
  assert.ok(s.y - s.height / 2 - 0.08 > LOFT.y + 1, 'frame clears the couch backrest');
  assert.ok(s.y + s.height / 2 + 0.08 < LOFT.y + LOFT.height, 'frame clears ceiling');
  assert.ok(s.width + 0.16 < 2.8, 'window edges remain visible');
  assert.ok(board.position.x < s.x && s.x < LOFT.maxX, 'face is in front of east frame');
  const normal = new Vector3(0, 0, 1).applyEuler(board.rotation);
  assert.ok(normal.distanceTo(new Vector3(-1, 0, 0)) < 1e-8);
  assert.equal(interactables.length, 1);
  assert.equal(interactables[0].kind, 'bossattention');
  assert.equal(interactables[0].y, LOFT.y);
  assert.ok(interactables[0].x < LOFT.maxX - 1.15, 'interaction anchor is outside couch collider');
  assert.equal(interactables[0].z, s.z);
});
