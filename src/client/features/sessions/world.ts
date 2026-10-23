import * as THREE from 'three';
import { PLANNING_ROOM } from '../../../shared/planning';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

// 🧭 The third screen: the inside of the planning room's south glass, on the left of whoever sits in the
// planner's chair facing the purple board (west), across the room from the 🎚️ switchboard on the north
// glass. It shows the floor's sessions on their way to the common goal (see ./face.ts); E opens it whole.

declare module '../../world/types' {
  interface OfficeHandles {
    sessionsScreen: THREE.Mesh;
  }
}

/** Its size, and how high its middle is, on the inside of the south glass. */
export const SESSIONS_SCREEN = { width: 4.4, height: 1.6, y: 1.42 } as const;

export const sessionsScreen: Fixture<'sessionsScreen'> = (site) => {
  const R = PLANNING_ROOM;
  const S = SESSIONS_SCREEN;
  const x = (R.minX + R.maxX) / 2;
  const z = R.maxZ - 0.06;
  const group = new THREE.Group();
  const bezel = mesh(roundedBox(S.width + 0.16, S.height + 0.16, 0.04, 0.03), toon('#14161f'), x, S.y, z, false);
  group.add(bezel);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(S.width, S.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(x, S.y, z - 0.025);
  face.rotation.y = Math.PI;
  group.add(face);
  // Used from between the table's south end and the glass.
  const it: Interactable = { kind: 'sessionswall', x, z: z - 1.05, radius: 1.6 };
  site.interactables.push(it);
  face.userData.interact = it;
  bezel.userData.interact = it;
  return { group, handle: { sessionsScreen: face } };
};
