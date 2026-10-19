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

// Inside the north glass, away from the telescope, stairs, desk and the Boss Office sign.
export const BOSS_ATTENTION_BOARD = { x: 12.2, y: LOFT.y + 1.5, z: LOFT.minZ + 0.19, width: 3.5, height: 1.7 } as const;

export const bossAttentionBoard: Fixture<'bossAttentionBoard'> = (site) => {
  const s = BOSS_ATTENTION_BOARD;
  const group = new THREE.Group();
  const frame = mesh(roundedBox(s.width + 0.16, s.height + 0.16, 0.08, 0.04), toon('#263347'), s.x, s.y, s.z, false);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(s.width, s.height), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  face.position.set(s.x, s.y, s.z + 0.045);
  const it: Interactable = { kind: 'bossattention', x: s.x, y: LOFT.y, z: s.z + 1, radius: 1.8 };
  face.userData.interact = it;
  frame.userData.interact = it;
  group.add(frame, face);
  site.interactables.push(it);
  return { group, handle: { bossAttentionBoard: face } };
};
