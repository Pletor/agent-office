import * as THREE from 'three';
import { LOFT, STAIRS } from '../../../shared/layout';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { PALETTE, box } from '../../world/office/materials';
import { CLEAN_LINE_BOARD } from '../cleanline/world';

// 🗂️ Výstupy · Čistá linie: on the loft's floor right under the Čistá linie board (south wall), a ledge
// like the orchestrator's (a plate on a dark tray on two legs, tipped back to be read from standing),
// facing north into the room. It sits east of the board's middle, so the way in from the stairs door
// (west wall) stays clear; the board above it is still in plain view.

declare module '../../world/types' {
  interface OfficeHandles {
    /** The Výstupy ledge's face. */
    outputsBoard: THREE.Mesh;
  }
}

const B = CLEAN_LINE_BOARD;
/** The ledge: its middle (x, z), size, the height of its plate over the loft floor and how far it's tipped back. */
export const OUTPUTS_LEDGE = { x: B.x + 0.4, z: B.z - B.depth / 2 - 0.3, width: 2.4, height: 0.36, y: 0.34, tilt: 0.7 } as const;

export const outputsBoard: Fixture<'outputsBoard'> = (site) => {
  const L = OUTPUTS_LEDGE;
  const group = new THREE.Group();
  const ledge = new THREE.Group();
  ledge.position.set(L.x, LOFT.y + L.y, L.z);
  ledge.rotation.y = Math.PI;
  const tipped = new THREE.Group();
  tipped.rotation.x = -L.tilt;
  ledge.add(tipped);
  const tray = mesh(roundedBox(L.width + 0.12, L.height + 0.1, 0.05, 0.03), toon('#2b2d42'), 0, 0, -0.03, false);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(L.width, L.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.z = 0.002;
  tipped.add(tray, face);
  const legMat = toon(PALETTE.deskLeg);
  for (const s of [-1, 1]) ledge.add(mesh(box(0.05, L.y, 0.05), legMat, s * (L.width / 2 - 0.15), -L.y / 2, -0.08));
  group.add(ledge);
  const it: Interactable = { kind: 'outputs', x: L.x, y: LOFT.y, z: L.z - 1.1, radius: 1.6 };
  face.userData.interact = it;
  tray.userData.interact = it;
  site.interactables.push(it);
  site.colliders.push({ minX: L.x - L.width / 2 - 0.06, maxX: L.x + L.width / 2 + 0.06, minZ: L.z - 0.2, maxZ: L.z + 0.2, bottom: LOFT.y, top: LOFT.y + L.y + 0.15 });
  return { group, handle: { outputsBoard: face } };
};

/** Where the way in from the stairs door ends: the ledge keeps this far east of the loft's west wall. */
export const DOOR_CLEARANCE = OUTPUTS_LEDGE.x - OUTPUTS_LEDGE.width / 2 - STAIRS.toX;
