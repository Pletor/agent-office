import { HarnessProfiles, HarnessError } from './profiles.js';
import { HarnessBindings } from './bindings.js';
import { harnessCanvas } from './canvas.js';
import { oporaOrigin } from './hierarchy-context.js';
import { harnessPath } from '../../shared/harness-hierarchy.js';
import { parseOporaKey, samePlace } from '../../shared/opora-identity.js';

/** Bindings make real Opora task handoffs inherit all seven levels; custom legacy tasks stay portable. */
export async function boundHarnessProfile(dataDir: string, repo: string, task: string) {
  const store = new HarnessProfiles(dataDir), at = parseOporaKey(task);
  if (!at) return store.view(repo, task);
  const bindings = new HarnessBindings(dataDir), bound = bindings.forRepo(repo);
  if (!bound) return store.view(repo, task);
  if (!samePlace(at, bound)) throw new HarnessError('Úkol je z jiného projektu nebo prostoru než připojení tohoto repozitáře.', 409);
  const base = process.env.AGENT_OFFICE_OPORA_URL || bound.baseUrl || 'http://127.0.0.1:8740';
  if (bound.baseUrl && oporaOrigin(base) !== bound.baseUrl) throw new HarnessError('Adresa Opory se změnila. Obnovte připojení patra před přípravou výbavy.', 409);
  const nodes = await harnessCanvas(base, bound);
  if (!nodes.some(n => n.id === at.nodeId)) throw new HarnessError('Úkol už v připojeném projektu není.', 404);
  const latest = bindings.forRepo(repo);
  if (!samePlace(bound, latest) || bound.baseUrl !== latest?.baseUrl) throw new HarnessError('Připojení se během přípravy změnilo. Opakujte přípravu.', 409);
  return store.view(repo, harnessPath(nodes, bound, at.nodeId));
}
