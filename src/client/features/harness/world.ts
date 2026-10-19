import { HARNESS_SHELF } from '../../../shared/harness-layout';
import { buildBookshelf } from '../bookshelf/world';
import type { Fixture } from '../../world/office/fixture';

export const harnessShelf: Fixture = (site) => {
  const shelf = buildBookshelf(HARNESS_SHELF, '📚 Harness', 'harness');
  site.wall('south', HARNESS_SHELF.x, (HARNESS_SHELF.height + 0.55) / 2, HARNESS_SHELF.width + 0.2, HARNESS_SHELF.height + 0.55);
  return { group: shelf.group, colliders: [shelf.collider], interactables: [shelf.interactable] };
};
