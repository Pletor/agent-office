import * as THREE from 'three';
import type { Fixture } from '../../world/office/fixture';
import type { Interactable } from '../../world/types';

/** Above the existing north-wall boards and their labels, below the 6.8 m ceiling; 4:1 like its 2048×512 texture. */
export const PROCESS_WALL = { x: -3.9, y: 5.58, z: -12.72, width: 9, height: 2.25 } as const;
export interface ProcessWall { screen: THREE.Mesh; group: THREE.Group }
declare module '../../world/types' { interface OfficeHandles { processWall: ProcessWall } }

export const processWall: Fixture<'processWall'> = site => {
  const p = PROCESS_WALL, group = new THREE.Group();
  group.position.set(p.x, p.y, p.z);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(p.width + .18, p.height + .18, .14), new THREE.MeshStandardMaterial({ color: '#2b2d42', metalness: .5, roughness: .45 }));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(p.width, p.height), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, fog: false }));
  screen.position.z = .08; group.add(frame, screen);
  const it: Interactable = { kind: 'processwall', x: p.x, z: p.z + 5, radius: 2.5 };
  group.userData.interact = it;
  site.wall('north', p.x, p.y, p.width + .2, p.height + .2);
  return { group, interactables: [it], handle: { processWall: { screen, group } } };
};
