import * as THREE from 'three';
import { FLOOR, GONG } from '../../../shared/layout';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

// 🚦 The status wall ("Stav"): a screen high on the north wall over the gong, right beside the
// elevator everyone comes and goes by, above the heads of whoever's at the gong and the PR board, so
// it reads from the desks and the lounge across the room. The same spot on every floor of the
// office's own map; a map of its own (the castle) has no office walls, and so no wall.

declare module '../../world/types' {
  interface OfficeHandles {
    statusScreen: THREE.Mesh;
  }
}

/** Its size, and where its middle is: over the gong, clear of its frame (2.45 m) and of the ceiling (6.8 m). */
export const STATUS_WALL = { x: GONG.x, y: 4.2, width: 3, height: 1.75 } as const;

export const statusScreen: Fixture<'statusScreen'> = (site) => {
  const S = STATUS_WALL;
  const z = FLOOR.minZ;
  const group = new THREE.Group();
  const bezel = mesh(roundedBox(S.width + 0.16, S.height + 0.16, 0.08, 0.04), toon('#14161f'), S.x, S.y, z + 0.05, false);
  group.add(bezel);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(S.width, S.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(S.x, S.y, z + 0.095);
  group.add(face);
  // Aimed at from anywhere in reach (it's high up); in third person, standing back from the gong.
  const it: Interactable = { kind: 'status', x: S.x, z: z + 4, radius: 1.5 };
  site.interactables.push(it);
  face.userData.interact = it;
  bezel.userData.interact = it;
  site.wall('north', S.x, S.y, S.width + 0.3, S.height + 0.3);
  return { group, handle: { statusScreen: face } };
};
