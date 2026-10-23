import * as THREE from 'three';
import { PLANNING_ROOM } from '../../../shared/planning';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

// 🎚️ The switchboard: the inside of the planning room's north glass, behind the 🛰️ Opora screen that
// faces the desks. It shows the project's architecture as a cascade (environment → domain → page →
// subpage) with what's switched on, which is what the cell works on (see ./screen.ts). It has the whole
// height of the glass: the deepest page switched on is also the orchestrator's card, with no plate of
// its own over it (features/orchestrator).

declare module '../../world/types' {
  interface OfficeHandles {
    oporaScopeBoard: THREE.Mesh;
  }
}

/** Its size, and how high its middle is, on the inside of the north glass. */
export const SCOPE_BOARD = { width: 4.2, height: 1.92, y: 1.66 } as const;

export const oporaScopeBoard: Fixture<'oporaScopeBoard'> = (site) => {
  const R = PLANNING_ROOM;
  const S = SCOPE_BOARD;
  const x = (R.minX + R.maxX) / 2;
  const z = R.minZ + 0.06;
  const group = new THREE.Group();
  const bezel = mesh(roundedBox(S.width + 0.14, S.height + 0.14, 0.04, 0.03), toon('#14161f'), x, S.y, z, false);
  group.add(bezel);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(S.width, S.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(x, S.y, z + 0.025);
  group.add(face);
  // Used from between the glass and the table's north end.
  const it: Interactable = { kind: 'oporascope', x, z: z + 1.05, radius: 1.6 };
  site.interactables.push(it);
  face.userData.interact = it;
  bezel.userData.interact = it;
  return { group, handle: { oporaScopeBoard: face } };
};
