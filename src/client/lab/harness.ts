// Vite-only visual fixture: the actual office and library, at the balcony doorway.
import '../styles/base.css';
import { stage, ready } from './stage';
import { preloadModels } from '../world/models';
import { buildOffice } from '../world/office/build';
import { openHarness } from '../features/harness/ui';
import { BALCONY_DOOR, FLOOR } from '../../shared/layout';

await preloadModels();
const s = stage(document.querySelector('canvas')!, false);
const office = buildOffice();
s.scene.add(office.group);
s.camera.fov = 55;
s.camera.updateProjectionMatrix();
s.camera.position.set(BALCONY_DOOR.u, 1.9, FLOOR.maxZ - 6);
s.camera.lookAt(BALCONY_DOOR.u, 1.4, FLOOR.maxZ);
s.render();
document.getElementById('open-harness')!.onclick = () => openHarness(new URLSearchParams(location.search).get('floor') ?? 'lab');
ready({ harness: office.interactables.find((i) => i.kind === 'harness'), docs: office.interactables.find((i) => i.kind === 'bookshelf') });
