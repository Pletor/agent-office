import * as THREE from 'three';
import { PLANNING_BOARD } from '../../../shared/planning';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

// 🛰️ The live canvas: a picture laid over the face of the planning room's board (the one facing the
// door), shown while the floor is linked to an Opora project, with the planning queue's board under
// it otherwise. It shows the way down to what the cell works on, its cards, and what the agents do
// on the canvas as they do it (see ./screen.ts).

declare module '../../world/types' {
  interface OfficeHandles {
    oporaLiveBoard: { face: THREE.Mesh; use: Interactable };
  }
}

export const oporaLiveBoard: Fixture<'oporaLiveBoard'> = (site) => {
  const b = PLANNING_BOARD;
  const group = new THREE.Group();
  // Just in front of the board's own face (0.07 out from its frame).
  const face = new THREE.Mesh(new THREE.PlaneGeometry(b.width, b.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(b.x + 0.085, b.bottom + b.height / 2, b.z);
  face.rotation.y = Math.PI / 2;
  face.visible = false;
  group.add(face);
  const use: Interactable = { kind: 'oporalive', x: b.x + 1.2, z: b.z, radius: 2.2, off: true };
  site.interactables.push(use);
  face.userData.interact = use;
  return { group, handle: { oporaLiveBoard: { face, use } } };
};
