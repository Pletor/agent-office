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

// Above the red couch at the east window, facing into the Boss Office.
export const BOSS_ATTENTION_BOARD = { x: LOFT.maxX - 0.19, y: LOFT.y + 1.85, z: (LOFT.minZ + LOFT.maxZ) / 2, width: 2.2, height: 1.15 } as const;

export const bossAttentionBoard: Fixture<'bossAttentionBoard'> = (site) => {
  const s = BOSS_ATTENTION_BOARD;
  const group = new THREE.Group();
  const frame = mesh(roundedBox(s.width + 0.16, s.height + 0.16, 0.08, 0.04), toon('#263347'), s.x, s.y, s.z, false);
  frame.rotation.y = -Math.PI / 2;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(s.width, s.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(s.x - 0.045, s.y, s.z);
  face.rotation.y = -Math.PI / 2;
  const it: Interactable = { kind: 'bossattention', x: s.x - 1, y: LOFT.y, z: s.z, radius: 1.8 };
  face.userData.interact = it;
  frame.userData.interact = it;
  group.add(frame, face);
  site.interactables.push(it);
  return { group, handle: { bossAttentionBoard: face } };
};
