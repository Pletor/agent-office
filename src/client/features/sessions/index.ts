/**
 * 🧭 Relace k cíli: the third screen of the planning room (Opora Control Center), on the inside of its
 * south glass, the left of whoever sits in the planner's chair facing the purple board. Its face shows the
 * floor's sessions on their way to the common goal, live; E opens it whole: the goal and its three-level
 * bar, every session by its Opora card with its checklist, sub-sessions and /btw questions, the dead ends,
 * orphans, who waits on a person and the follow-up work to start, and each session's detail. When a card
 * is picked for the orchestrator (the right board), that card's sessions come up top, lit.
 */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import type { Modal } from '../../ui/dom';
import { SessionsData, TOPICS } from './data';
import { openSessionDetail } from './detail';
import { SessionsFaceTexture } from './face';
import { openScreen } from './screen';

declare module '../../world/types' {
  interface InteractKinds {
    sessionswall: true;
  }
}

export interface SessionsDeps {
  /** Walks you to a worker's desk and opens its terminal (WaitingPart.answerWorker). */
  answerWorker(id: string): void;
}

export function installSessions(ctx: Ctx, deps: SessionsDeps) {
  const data = new SessionsData();
  let screen: Modal | undefined;
  const showDetail = (rowId: string) => openSessionDetail(rowId, { net: ctx.net, messages: ctx.messages, data, answerWorker: deps.answerWorker });
  const showScreen = () => { screen?.close(); screen = openScreen({ net: ctx.net, data, openDetail: showDetail }); };

  ctx.interactions.define('sessionswall', {
    reach: 5,
    hint: () => {
      const { board, att } = data.board();
      const what = `${board.rows.length} relací · ${att.dead.length} slepých uliček · ${att.hum.length} čeká`;
      return { k: what, parts: [hintTitle('🧭 Relace k cíli'), aside(what), key('E', 'Otevřít obrazovku')] };
    },
    use: onE(showScreen),
  });

  const face = new SessionsFaceTexture();
  const mat = ctx.office.sessionsScreen.material as THREE.MeshBasicMaterial;
  mat.map = face.texture;
  mat.needsUpdate = true;
  let frame = 0;
  const draw = () => {
    frame = 0;
    const { board, att } = data.board();
    face.render(board, att, !!store.opora.project);
  };
  const later = () => { if (!frame) frame = requestAnimationFrame(draw); };
  for (const t of TOPICS) store.on(t, later);
  store.on('floor', () => { data.refresh(true); later(); });
  data.onChange(later);
  // Minutes without a move tick on, and the plan numbers and clean line are read again now and then.
  setInterval(() => { data.refresh(); later(); }, 30_000);
  draw();
}
