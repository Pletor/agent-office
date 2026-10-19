import * as THREE from 'three';
import { LOFT } from '../../../shared/layout';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

declare module '../../world/types' {
  interface OfficeHandles {
    bossAttentionBoard: THREE.Mesh;
  }
}

// Opaque wall-backed panel covering the entire east window, frame and sill behind the couch.
export const BOSS_ATTENTION_BOARD = { x: LOFT.maxX - 0.13, y: LOFT.y + 1.7, z: (LOFT.minZ + LOFT.maxZ) / 2, width: 3.2, height: 1.8, depth: 0.3 } as const;

export const bossAttentionBoard: Fixture<'bossAttentionBoard'> = (site) => {
  const s = BOSS_ATTENTION_BOARD;
  const group = new THREE.Group();
  const frame = mesh(roundedBox(s.width + 0.16, s.height + 0.16, s.depth, 0.04), toon('#263347'), s.x, s.y, s.z, false);
  frame.rotation.y = -Math.PI / 2;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(s.width, s.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(s.x - s.depth / 2 - 0.005, s.y, s.z);
  face.rotation.y = -Math.PI / 2;
  const it: Interactable = { kind: 'bossattention', x: s.x - 1.2, y: LOFT.y, z: s.z, radius: 1.8 };
  face.userData.interact = it;
  frame.userData.interact = it;
  group.add(frame, face);
  site.interactables.push(it);
  return { group, handle: { bossAttentionBoard: face } };
};
