import { BALCONY_DOOR, BOOKSHELF } from './layout.js';
/** Mirror Docs across the balcony doorway; clear of the door and the window. */
export const HARNESS_SHELF = { ...BOOKSHELF, x: 2 * BALCONY_DOOR.u - BOOKSHELF.x };
