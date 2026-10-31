import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { LOFT, STAIRS } from '../src/shared/layout.js';
import { CLEAN_LINE_BOARD } from '../src/client/features/cleanline/world.js';
import { DOOR_CLEARANCE, OUTPUTS_LEDGE, outputsBoard } from '../src/client/features/outputs/world.js';
import type { Site } from '../src/client/world/office/fixture.js';
import type { Collider, Interactable } from '../src/client/world/types.js';

test('the Výstupy ledge stands on the loft floor under the Čistá linie board, faces the room and keeps the door clear', () => {
  const interactables: Interactable[] = [];
  const colliders: Collider[] = [];
  const built = outputsBoard({ interactables, colliders, wall: () => {} } as unknown as Site);
  const face = built.handle!.outputsBoard;
  const L = OUTPUTS_LEDGE, B = CLEAN_LINE_BOARD;
  built.group!.updateMatrixWorld(true);
  const at = new Vector3().setFromMatrixPosition(face.matrixWorld);
  assert.ok(at.y > LOFT.y && at.y + L.height / 2 < B.y - B.height / 2, 'on the loft floor, below the board');
  assert.ok(Math.abs(at.x - B.x) < B.width / 2, 'under the board');
  const normal = new Vector3(0, 0, 1).transformDirection(face.matrixWorld);
  assert.ok(normal.z < -0.5 && normal.y > 0.3, 'faces north into the room, tipped back');
  // In front of the board's backing, clear of the stairs door (west wall, from STAIRS.minZ) and in the loft.
  const [c] = colliders;
  assert.equal(colliders.length, 1);
  assert.ok(c.maxZ <= B.z - B.depth / 2, 'in front of the board, not in it');
  assert.ok(c.minX - STAIRS.toX >= 1.1 && DOOR_CLEARANCE >= 1.1, 'a wide way in from the stairs door');
  assert.ok(c.minZ > STAIRS.minZ, 'only the strip along the south wall');
  assert.ok(c.maxX < LOFT.maxX - 3 && c.bottom === LOFT.y);
  // E reaches it from the room.
  const [it] = interactables;
  assert.equal(it.kind, 'outputs');
  assert.equal(it.y, LOFT.y);
  assert.ok(it.z < c.minZ && it.z > LOFT.minZ + 1, 'you stand in front of it');
  assert.equal(face.userData.interact, it);
});
