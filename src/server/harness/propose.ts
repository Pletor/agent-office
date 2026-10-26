import type http from 'node:http';
import type { Floor } from '../floor.js';
import { OporaClient, OporaError } from '../opora/client.js';
import { readBody, send } from '../http/util.js';
import { parseOporaKey } from '../../shared/opora-identity.js';
import { HarnessLibrary } from './catalog.js';
import { buildHarnessKit } from './kit.js';
import { HarnessError } from './profiles.js';

export interface KitProposal { id: string; card: string; resources: number; opora: string }

/**
 * Put a verified kit into one card's specification as an Opora changeset (fields.harness). The card's
 * goal, non-goals, acceptance and steps travel unchanged; a person accepts the change in Opora, and only
 * then does a worker that claims the card (context v2) get exactly this kit.
 */
export async function proposeKit(floor: Floor, library: HarnessLibrary, input: { card: unknown; problem: unknown; resources: unknown },
  client: (url: string) => Pick<OporaClient, 'changesetContext' | 'proposeChangeset'> = url => new OporaClient(url, 'office-harness')): Promise<KitProposal> {
  const view = floor.opora.view();
  if (!view.connected || !view.project || !view.workspace) throw new HarnessError('Patro není připojené k otevřené Opoře.', 409);
  const place = typeof input.card === 'string' ? parseOporaKey(input.card) : undefined;
  if (!place || place.project !== view.project.id || place.workspace !== view.workspace) throw new HarnessError('Karta musí být z připojeného projektu a pracovního prostoru Opory.', 403);
  if (typeof input.problem !== 'string' || !Array.isArray(input.resources) || !input.resources.every(id => typeof id === 'string'))
    throw new HarnessError('Očekává se { card, problem, resources[] }.');
  const kit = await buildHarnessKit(library, input.problem, input.resources as string[]);
  const opora = client(view.url), context = await opora.changesetContext(place.project, place.workspace);
  if (context.readOnly === true) throw new HarnessError('Opora je jen pro čtení.', 409);
  if (typeof context.acceptedHead !== 'string' || typeof context.graphDigest !== 'string') throw new HarnessError('Plán v Opoře ještě nemá přijatý základ.', 409);
  const document = context.documents?.find(doc => doc.nodeId === place.nodeId);
  if (!document || !context.acceptedDocuments?.some(doc => doc.nodeId === place.nodeId)) throw new HarnessError('Karta nemá přijaté zadání; nejdřív ho přijměte v Opoře.', 409);
  for (const key of ['goal', 'non_goals', 'acceptance']) if (typeof document.fields?.[key] !== 'string') throw new HarnessError('Zadání karty nemá ' + key + '.', 409);
  const result = await opora.proposeChangeset({
    project: place.project, workspace: place.workspace, parentRevision: context.acceptedHead, expectedGraphDigest: context.graphDigest,
    subject: `Výbava Harness: ${input.problem} (${kit.resources.length})`.slice(0, 200),
    changes: [{ nodeId: place.nodeId, expectedRevision: document.revision, fields: { ...document.fields, harness: kit } }],
  });
  if (typeof result.id !== 'string') throw new HarnessError('Opora návrh nepotvrdila.', 502);
  return { id: result.id, card: place.nodeId, resources: kit.resources.length, opora: view.url };
}

/** The browser route and the worker hook API (`office-harness --propose`) answer the same way. */
export async function proposeRequest(floor: Floor, library: HarnessLibrary, req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = JSON.parse(await readBody(req, 64_000));
    return send(res, 200, await proposeKit(floor, library, body ?? {}), { 'cache-control': 'no-store' });
  } catch (err) {
    const status = err instanceof HarnessError ? err.status : err instanceof OporaError ? (err.status === 409 ? 409 : 502) : 400;
    return send(res, status, { error: (err as Error).message });
  }
}
