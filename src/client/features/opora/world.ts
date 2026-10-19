import * as THREE from 'three';
import { PLANNING_ROOM } from '../../../shared/planning';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

// Opora on the glass: a screen on the planning room's north glass, facing the desks and the elevator,
// that shows the Opora canvas's pipeline (see ./screen.ts). E at it opens the 🛰️ Opora window.

declare module '../../world/types' {
  interface OfficeHandles {
    oporaScreen: THREE.Mesh;
  }
}

/** The screen: its size and how high its middle is, on the outside of the north glass. */
export const OPORA_SCREEN = { width: 4.6, height: 1.7, y: 1.4 } as const;

export const oporaScreen: Fixture<'oporaScreen'> = (site) => {
  const R = PLANNING_ROOM;
  const S = OPORA_SCREEN;
  const x = (R.minX + R.maxX) / 2;
  const z = R.minZ - 0.1;
  const group = new THREE.Group();
  // A thin dark bezel, hung on the glass, and the picture in it.
  const bezel = mesh(roundedBox(S.width + 0.12, S.height + 0.12, 0.04, 0.03), toon('#14161f'), x, S.y, z + 0.02, false);
  group.add(bezel);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(S.width, S.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(x, S.y, z - 0.005);
  face.rotation.y = Math.PI;
  group.add(face);
  const it: Interactable = { kind: 'opora', x, z: z - 1.4, radius: 2.4 };
  site.interactables.push(it);
  face.userData.interact = it;
  bezel.userData.interact = it;
  return { group, handle: { oporaScreen: face } };
};
