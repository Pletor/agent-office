import * as THREE from 'three';
import { LOFT, WINDOWS } from '../../../shared/layout';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

declare module '../../world/types' {
  interface OfficeHandles {
    cleanLineBoard: THREE.Mesh;
  }
}

const SOUTH_WINDOW = WINDOWS.find((w) => w.wall === 'south' && w.y0 > LOFT.y)!;

// On the loft's south wall, inside, facing north into the room: an opaque wall-backed panel over the
// loft's south window, frame and sill (as the Pro tebe board covers the east one), between the stairs
// door and the Boss Office sign.
export const CLEAN_LINE_BOARD = { x: SOUTH_WINDOW.u, y: LOFT.y + 1.7, z: LOFT.maxZ - 0.13, width: 3.2, height: 1.8, depth: 0.3 } as const;

export const cleanLineBoard: Fixture<'cleanLineBoard'> = (site) => {
  const s = CLEAN_LINE_BOARD;
  const group = new THREE.Group();
  const frame = mesh(roundedBox(s.width + 0.16, s.height + 0.16, s.depth, 0.04), toon('#263347'), s.x, s.y, s.z, false);
  frame.rotation.y = Math.PI;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(s.width, s.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(s.x, s.y, s.z - s.depth / 2 - 0.005);
  face.rotation.y = Math.PI;
  const it: Interactable = { kind: 'cleanline', x: s.x, y: LOFT.y, z: s.z - 1.3, radius: 1.8 };
  face.userData.interact = it;
  frame.userData.interact = it;
  group.add(frame, face);
  site.interactables.push(it);
  // Pictures don't hang over it, and you don't walk through its backing.
  site.wall('south', s.x, s.y, s.width + 0.2, s.height + 0.2);
  site.colliders.push({ minX: s.x - s.width / 2 - 0.08, maxX: s.x + s.width / 2 + 0.08, minZ: s.z - s.depth / 2, maxZ: LOFT.maxZ, bottom: LOFT.y, top: LOFT.y + LOFT.height });
  return { group, handle: { cleanLineBoard: face } };
};
