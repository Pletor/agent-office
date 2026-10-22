import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { LOFT, STAIRS, WINDOWS } from '../src/shared/layout.js';
import { CLEAN_LINE_BOARD, cleanLineBoard } from '../src/client/features/cleanline/world.js';
import type { Site } from '../src/client/world/office/fixture.js';
import type { Collider, Interactable } from '../src/client/world/types.js';

test('the clean line board covers the loft south window, faces into the loft and reserves its wall', () => {
  const interactables: Interactable[] = [];
  const colliders: Collider[] = [];
  const walls: unknown[][] = [];
  const built = cleanLineBoard({ interactables, colliders, wall: (...a: unknown[]) => walls.push(a) } as unknown as Site);
  const face = built.handle!.cleanLineBoard;
  const s = CLEAN_LINE_BOARD;
  const win = WINDOWS.find((w) => w.wall === 'south' && w.y0 > LOFT.y)!;
  assert.ok(s.width > win.width + 0.2 && Math.abs(s.x - win.u) < 1e-9, 'covers the window and its frame');
  assert.ok(s.y - s.height / 2 < win.y0 - 0.06 && s.y + s.height / 2 > win.y1, 'covers sill and top frame');
  assert.ok(s.y + s.height / 2 + 0.08 < LOFT.y + LOFT.height, 'clears the ceiling');
  assert.ok(s.x - s.width / 2 > STAIRS.toX, 'clear of the stairs door');
  assert.ok(s.x + s.width / 2 < LOFT.maxX - 3 - 1.3, 'clear of the Boss Office sign');
  const normal = new Vector3(0, 0, 1).applyEuler(face.rotation);
  assert.ok(normal.distanceTo(new Vector3(0, 0, -1)) < 1e-8, 'faces north into the loft');
  assert.ok(face.position.z < s.z);
  assert.equal(interactables[0].kind, 'cleanline');
  assert.ok(interactables[0].z < LOFT.maxZ - 1);
  assert.deepEqual(walls[0].slice(0, 2), ['south', s.x]);
  assert.equal(colliders.length, 1);
});
