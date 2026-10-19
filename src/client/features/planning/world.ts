import * as THREE from 'three';
import { WALL_HEIGHT, deskSeat } from '../../../shared/layout';
import { PLANNER_SEAT, PLANNING_BOARD, PLANNING_ROOM, PLANNING_TABLE } from '../../../shared/planning';
import { mesh, roundedBox, textPlane, toon } from '../../world/toon';
import type { DeskView, Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { PALETTE, box, glassPane } from '../../world/office/materials';
import { pendant, wallBoard } from '../../world/office/props';
import { chair } from '../../world/office/seats';

// The planning room (🧭 Opora Control Center): glass walls round the open floor between the desks and
// the lounge, with a sliding door facing the lounge, a table with the planner's chair at its end, and
// the board the plan goes up on, standing by the far wall facing the table (see shared/planning.ts).

declare module '../../world/types' {
  interface OfficeHandles {
    /** The planning room's board, showing the plan as it's written, and the planner's chair to use. */
    planningBoard: THREE.Mesh;
    plannerSeat: Interactable;
  }
}

const T = 0.1;

export const planningRoom: Fixture<'planningBoard' | 'plannerSeat'> = (site) => {
  const R = PLANNING_ROOM;
  const H = R.height;
  const group = new THREE.Group();
  const frameMat = toon('#ffffff');
  const bar = (w: number, h: number, d: number, x: number, y: number, z: number) => group.add(mesh(box(w, h, d), frameMat, x, y, z, false));

  /** A run of glass along x (north and south walls) or z (west and east), from a to b, in panes about `pane` wide. */
  const run = (axis: 'x' | 'z', a: number, b: number, at: number, pane = 2.2) => {
    const len = b - a;
    const n = Math.max(1, Math.round(len / pane));
    for (let i = 0; i < n; i++) {
      const g = glassPane(len / n, H);
      const u = a + (i + 0.5) * (len / n);
      if (axis === 'x') g.position.set(u, H / 2, at);
      else {
        g.position.set(at, H / 2, u);
        g.rotation.y = Math.PI / 2;
      }
      group.add(g);
    }
    for (let i = 0; i <= n; i++) {
      const u = a + i * (len / n);
      if (axis === 'x') bar(0.08, H, T + 0.04, u, H / 2, at);
      else bar(T + 0.04, H, 0.08, at, H / 2, u);
    }
    for (const y of [0.05, H - 0.05]) {
      if (axis === 'x') bar(len, 0.1, T + 0.06, (a + b) / 2, y, at);
      else bar(T + 0.06, 0.1, len, at, y, (a + b) / 2);
    }
    site.colliders.push(axis === 'x' ? { minX: a, maxX: b, minZ: at - T / 2, maxZ: at + T / 2, top: H } : { minX: at - T / 2, maxX: at + T / 2, minZ: a, maxZ: b, top: H });
  };
  run('x', R.minX, R.maxX, R.minZ);
  run('x', R.minX, R.maxX, R.maxZ);
  run('z', R.minZ, R.maxZ, R.minX);
  run('z', R.minZ, R.door.z0, R.maxX, 1.6);
  run('z', R.door.z1, R.maxZ, R.maxX, 1.6);
  // Over the door, and the top of the glass across it.
  bar(T + 0.06, H - 2.3, R.door.z1 - R.door.z0, R.maxX, (H + 2.3) / 2, (R.door.z0 + R.door.z1) / 2);

  // The door: two glass leaves that slide apart along the wall when someone comes up.
  const dz = (R.door.z0 + R.door.z1) / 2;
  const half = (R.door.z1 - R.door.z0) / 2;
  const alu = toon('#aab4be');
  const leaves: [THREE.Group, number][] = [];
  for (const side of [-1, 1]) {
    const leaf = new THREE.Group();
    const h = 2.25;
    for (const y of [0.04, h - 0.04]) leaf.add(mesh(box(0.04, 0.07, half), alu, 0, y, 0, false));
    for (const z of [-half / 2 + 0.03, half / 2 - 0.03]) leaf.add(mesh(box(0.04, h, 0.06), alu, 0, h / 2, z, false));
    const pane = glassPane(half - 0.12, h - 0.14);
    pane.position.y = h / 2;
    pane.rotation.y = Math.PI / 2;
    leaf.add(pane);
    leaf.add(mesh(box(0.07, 0.4, 0.03), toon(PALETTE.ink), 0, 1.05, -side * (half / 2 - 0.1), false));
    const z0 = dz + (side * half) / 2;
    leaf.position.set(R.maxX + T / 2 + 0.04, 0, z0);
    group.add(leaf);
    leaves.push([leaf, z0]);
  }
  site.doors.push({
    x: R.maxX,
    y: 0,
    z: dz,
    open: 0,
    show: (k) => {
      const e = k * k * (3 - 2 * k);
      for (const [leaf, z0] of leaves) leaf.position.z = z0 + Math.sign(z0 - dz) * e * (half - 0.06);
    },
  });
  // The department's sign over the door, facing the lounge.
  const label = textPlane('🧭 Opora Control Center', { bg: '#2b2d42', color: '#fffaf3', size: 56, border: '#fffaf3' });
  label.scale.multiplyScalar(0.55);
  label.position.set(R.maxX + 0.13, 2.52, dz);
  label.rotation.y = Math.PI / 2;
  group.add(label);
  // Its name on the north glass too, for the desks and the elevator.
  const north = textPlane('🧭 Planning room', { bg: '#2b2d42', color: '#fffaf3', size: 48, border: '#fffaf3' });
  north.scale.multiplyScalar(0.5);
  north.position.set((R.minX + R.maxX) / 2, 2.45, R.minZ - 0.1);
  north.rotation.y = Math.PI;
  group.add(north);

  // The table, its long side north–south, on two pedestals.
  const t = PLANNING_TABLE;
  const table = new THREE.Group();
  table.add(mesh(roundedBox(t.width, 0.08, t.depth, 0.1), toon(PALETTE.wood), 0, t.height - 0.04, 0));
  for (const sz of [-1, 1]) {
    table.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, t.height - 0.08, 10), toon(PALETTE.deskLeg), 0, (t.height - 0.08) / 2, sz * (t.depth / 2 - 0.5)));
    table.add(mesh(roundedBox(0.8, 0.05, 0.7, 0.05), toon(PALETTE.deskLeg), 0, 0.025, sz * (t.depth / 2 - 0.5)));
  }
  // Sticky notes and a notebook, the planning under way.
  const notes = ['#ffd166', '#06d6a0', '#ef476f', '#8ecae6'];
  notes.forEach((c, i) => table.add(mesh(box(0.16, 0.01, 0.16), toon(c), -0.3 + (i % 2) * 0.2, t.height + 0.005, -0.8 + Math.floor(i / 2) * 0.22 + (i % 2) * 0.04, false)));
  table.add(mesh(box(0.3, 0.03, 0.42), toon('#2b2d42'), -0.25, t.height + 0.015, 0.75, false));
  table.position.set(t.x, 0, t.z);
  group.add(table);
  site.colliders.push({ minX: t.x - t.width / 2, maxX: t.x + t.width / 2, minZ: t.z - t.depth / 2, maxZ: t.z + t.depth / 2, top: t.height });
  const plan: Interactable = { kind: 'planning', x: t.x, z: t.z, radius: 2.4 };
  site.interactables.push(plan);
  table.userData.interact = plan;

  // The planner's chair at the table's east end, with its laptop on the table in front of it.
  const def = PLANNER_SEAT;
  const seat = new THREE.Group();
  seat.position.set(def.x, 0, def.z);
  seat.rotation.y = def.rotY;
  const laptopAnchor = new THREE.Object3D();
  laptopAnchor.position.set(0, t.height, 0.07);
  seat.add(laptopAnchor);
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0.4, 0.85);
  seatAnchor.rotation.y = Math.PI;
  seatAnchor.scale.setScalar(0.82);
  seat.add(seatAnchor);
  const ch = chair('#9b5de5');
  ch.position.set(0, 0, 0.85);
  seat.add(ch);
  const stage = new THREE.Object3D();
  stage.position.set(0, 0.48, 0.85);
  seat.add(stage);
  // Nobody is hired here from the floor, so there's no '+' over the free chair: a plan seats its planner.
  const vacancy = new THREE.Group();
  seat.add(vacancy);
  group.add(seat);
  const view: DeskView = { def, group: seat, laptopAnchor, seatAnchor, stage, chair: ch, vacancy, vacancyY: 0 };
  site.desks.set(def.id, view);
  const at = deskSeat(def, 1.2);
  // Only there to use while the planner sits in it (see features/planning): its terminal, like any worker's.
  const plannerSeat: Interactable = { kind: 'desk', deskId: def.id, x: at.x, z: at.z, radius: 1, off: true };
  site.interactables.push(plannerSeat);
  seat.userData.interact = plannerSeat;

  // The board, on two feet by the west wall, facing the table.
  const b = PLANNING_BOARD;
  const { group: frame, face } = wallBoard(b.width, b.height, '#9b5de5');
  frame.position.set(b.x, b.bottom + b.height / 2, b.z);
  frame.rotation.y = Math.PI / 2;
  group.add(frame);
  const legMat = toon(PALETTE.deskLeg);
  for (const s of [-1, 1]) {
    const z = b.z + s * (b.width / 2 - 0.2);
    group.add(mesh(box(0.06, b.bottom + 0.2, 0.06), legMat, b.x - 0.04, (b.bottom + 0.2) / 2, z));
    group.add(mesh(box(0.5, 0.04, 0.08), legMat, b.x, 0.02, z));
  }
  site.colliders.push({ minX: b.x - 0.25, maxX: b.x + 0.25, minZ: b.z - b.width / 2, maxZ: b.z + b.width / 2, top: b.bottom + b.height });
  const read: Interactable = { kind: 'planning', x: b.x + 1.2, z: b.z, radius: 2.2 };
  site.interactables.push(read);
  frame.userData.interact = read;

  // A lamp over the table, hung from the high ceiling like the ones over the desks; the room has no roof.
  const night = site.get('night');
  const lampY = 3.6;
  const lamp = pendant(WALL_HEIGHT - lampY);
  lamp.position.set(t.x, lampY, t.z);
  group.add(lamp);
  night.halos.push({ at: new THREE.Vector3(t.x, lampY - 0.12, t.z), size: 1.2, color: '#ffe08a' });
  // A purple rug under the table, the department's colour.
  group.add(mesh(roundedBox(3.4, 0.02, 3.6, 0.5), toon('#cdb4db'), t.x - 0.2, 0.012, t.z, false));

  return { group, handle: { planningBoard: face, plannerSeat } };
};
