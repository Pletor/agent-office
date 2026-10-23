import * as THREE from 'three';
import { PLANNING_BOARD, PLANNING_ROOM } from '../../../shared/planning';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { PALETTE, box } from '../../world/office/materials';

// The orchestrator's two boards in the planning room (🧭 Opora Control Center). Sat in the planner's
// chair facing the purple board (west), the north glass is on the right: the card picker is a plate
// along the top of that board, over the 🎚️ switchboard, showing the card picked for the orchestrator.
// The purple board gets a ledge under its face with the same card, which opens its full detail.

declare module '../../world/types' {
  interface OfficeHandles {
    /** The right board's card plate (north glass, over the switchboard) and the purple board's detail ledge. */
    orchestratorBoards: { picker: THREE.Mesh; detail: THREE.Mesh };
  }
}

/** The plate on the inside of the north glass, over the switchboard, under the glass's top bar. */
export const PICKER_PLATE = { width: 4.2, height: 0.34, y: 2.47 } as const;
/** The ledge under the purple board's face, tipped back toward whoever stands in front of it. */
export const DETAIL_LEDGE = { width: 3, height: 0.36, y: 0.34, out: 0.24, tilt: 0.7 } as const;

function face(w: number, h: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
}

export const orchestratorBoards: Fixture<'orchestratorBoards'> = (site) => {
  const R = PLANNING_ROOM;
  const group = new THREE.Group();

  // The right board: the plate over the switchboard, facing into the room.
  const P = PICKER_PLATE;
  const px = (R.minX + R.maxX) / 2;
  const pz = R.minZ + 0.07;
  const bezel = mesh(roundedBox(P.width + 0.14, P.height + 0.1, 0.04, 0.03), toon('#14161f'), px, P.y, pz, false);
  const picker = face(P.width, P.height);
  picker.position.set(px, P.y, pz + 0.025);
  group.add(bezel, picker);
  const pick: Interactable = { kind: 'cardpicker', x: px, z: pz + 1.3, radius: 1.8 };
  picker.userData.interact = pick;
  bezel.userData.interact = pick;

  // The purple board's ledge: a plate on a dark tray in front of its feet, tipped back to be read from standing.
  const B = PLANNING_BOARD, L = DETAIL_LEDGE;
  const ledge = new THREE.Group();
  ledge.position.set(B.x + L.out, L.y, B.z);
  ledge.rotation.y = Math.PI / 2;
  const tipped = new THREE.Group();
  tipped.rotation.x = -L.tilt;
  ledge.add(tipped);
  const tray = mesh(roundedBox(L.width + 0.12, L.height + 0.1, 0.05, 0.03), toon('#2b2d42'), 0, 0, -0.03, false);
  const detail = face(L.width, L.height);
  detail.position.z = 0.002;
  tipped.add(tray, detail);
  const legMat = toon(PALETTE.deskLeg);
  for (const s of [-1, 1]) ledge.add(mesh(box(0.05, L.y, 0.05), legMat, s * (L.width / 2 - 0.15), -L.y / 2, -0.08));
  group.add(ledge);
  const open: Interactable = { kind: 'carddetail', x: B.x + 1.2, z: B.z, radius: 2.2 };
  detail.userData.interact = open;
  tray.userData.interact = open;
  site.colliders.push({ minX: B.x + 0.1, maxX: B.x + L.out + 0.2, minZ: B.z - L.width / 2, maxZ: B.z + L.width / 2, top: L.y + 0.15 });

  return { group, interactables: [pick, open], handle: { orchestratorBoards: { picker, detail } } };
};
