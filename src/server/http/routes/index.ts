// Every HTTP route the office answers, in the order they're tried: a new route goes where it has to
// come in that order (see http/router.ts). The public ones are tried first, then the sign-in check,
// then the rest; the last one answers every path left with the client bundle, or a 404.
import type { Route } from '../router.js';
import { harnessRoute, harnessProfileRoute } from './harness.js';
import { harnessHierarchyRoute } from './harness-hierarchy.js';
import { harnessProposeRoute } from './harness-propose.js';
import { agentRoutes } from './agents.js';
import { authRoutes } from './auth.js';
import { bossAttentionRoutes } from './boss-attention.js';
import { cleanLineRoutes } from './cleanline.js';
import { outputsRoutes } from './outputs.js';
import { fileRoutes } from './files.js';
import { githubRoutes } from './github.js';
import { jukeboxRoutes } from './jukebox.js';
import { pageRoutes } from './pages.js';
import { oporaLayersRoutes } from './opora-layers.js';
import { oporaLensRoutes } from './opora-lens.js';
import { oporaPlanRoutes } from './opora-plan.js';
import { oporaPreviewRoutes } from './opora-preview.js';
import { processMemoryRoutes } from './process-memory.js';
import { processRoutes } from './process.js';
import { searchRoutes } from './search.js';
import { serviceRoutes } from './services.js';
import { isolatedExecutorRoutes } from '../../opora/isolated-service.js';

export const routes: readonly Route[] = [
  // Anyone.
  authRoutes.login,
  authRoutes.loginOptions,
  authRoutes.join,
  authRoutes.claimable,
  authRoutes.claim,
  authRoutes.link,
  authRoutes.logout,
  pageRoutes.health,
  pageRoutes.assets,
  pageRoutes.login,
  pageRoutes.claim,
  pageRoutes.join,
  pageRoutes.favicon,
  // Signed in.
  authRoutes.whoami,
  bossAttentionRoutes.read,
  outputsRoutes.read,
  outputsRoutes.diary,
  ...cleanLineRoutes,
  agentRoutes.models,
  fileRoutes.image,
  fileRoutes.whiteboardFile,
  fileRoutes.termDrop,
  fileRoutes.changedFile,
  fileRoutes.docs,
  harnessRoute,
  harnessProfileRoute,
  harnessHierarchyRoute,
  harnessProposeRoute,
  searchRoutes.search,
  serviceRoutes.forwards,
  ...isolatedExecutorRoutes,
  githubRoutes.github,
  jukeboxRoutes.upload,
  jukeboxRoutes.songs,
  jukeboxRoutes.remove,
  jukeboxRoutes.song,
  pageRoutes.office,
  pageRoutes.lite,
  ...processMemoryRoutes,
  processRoutes.events,
  oporaLensRoutes.read,
  oporaPlanRoutes.read,
  oporaPreviewRoutes.read,
  oporaPreviewRoutes.file,
  oporaLayersRoutes.read,
  pageRoutes.bundle,
];
