import type * as THREE from 'three';
import type { BossAttention } from '../../../shared/boss-attention';
import type { Ctx } from '../../core/context';
import { hintTitle, key, onE } from '../../core/hint';
import { needingYou } from '../../nextup';
import { store } from '../../state';
import { AttentionController } from './controller';
import { AttentionScreen } from './screen';
import { openBossAttention } from './ui';

declare module '../../world/types' {
  interface InteractKinds {
    bossattention: true;
  }
}

export function installBossAttention(ctx: Ctx, deps: { answerWorker(id: string): void }) {
  const controller = new AttentionController(async (floor, signal) => {
    const res = await fetch(`/api/boss-attention?${new URLSearchParams({ floor })}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as BossAttention;
  });
  const screen = new AttentionScreen();
  const mat = ctx.office.bossAttentionBoard.material as THREE.MeshBasicMaterial;
  mat.map = screen.texture;
  mat.needsUpdate = true;
  const draw = () => screen.render(controller.view, needingYou(store.workers.values()).map((w) => w.name));
  const scope = () => controller.setScope(store.floor, store.opora.project?.id ?? null, store.opora.workspace);
  controller.onChange(draw);
  store.on('floor', scope);
  store.on('opora', scope);
  store.on('workers', draw);
  ctx.messages.on('welcome', scope);
  // Whole workspace, not only the switchboard's focus. Never write, take or approve a card here.
  setInterval(() => { if (!document.hidden) void controller.refresh(); }, 15_000);
  ctx.interactions.define('bossattention', {
    reach: 4,
    hint: () => ({ k: 'bossattention', parts: [hintTitle('Pro tebe — Boss Office'), key('E', 'Otevřít tabuli')] }),
    use: onE(() => openBossAttention(controller, deps.answerWorker)),
  });
  scope();
  draw();
}
