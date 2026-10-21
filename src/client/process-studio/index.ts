import './style.css';
import { initialState, parseRepository, reduceEvent, type Repository, type StudioEvent, type StudioState } from './model';
import { eventFor, scenario } from './scenario';
import { ProcessGraph } from './graph';
import { SpiderMotion } from './motion';
import { DeliveryPipeline } from './pipeline';
import { $, renderPanels, showPanel, type Panel } from './panels';

let repositories: Repository[] = [];
let runNumber = 42;
let state = initialState();
let scenes = scenario(repositories);
let sceneIndex = 0;
let selected = 'plan';
let events: StudioEvent[] = [];
let snapshots: StudioState[] = [structuredClone(state)];
let replayIndex: number | null = null;
let running = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let timer: ReturnType<typeof setTimeout> | undefined;
let follow = true;

const graph = new ProcessGraph($('#graph'), id => {
  selected = id; follow = false; showPanel('detail'); render();
});
const motion = new SpiderMotion(graph);
const pipeline = new DeliveryPipeline();

function render() {
  const displayed = replayIndex === null ? state : snapshots[replayIndex];
  graph.update(displayed, selected);
  pipeline.update(displayed);
  motion.update(displayed, running && replayIndex === null);
  renderPanels(displayed, selected, events, replayIndex !== null);
  $('#play').textContent = running ? 'Ⅱ Pozastavit' : state.finished && replayIndex === null ? '↺ Přehrát znovu' : '▶ Přehrát';
  $('#history-label').textContent = replayIndex === null ? `${events.length} událostí · doložená stopa ukázky` : `Historie ${replayIndex} / ${events.length}`;
  const timeline = $<HTMLInputElement>('#timeline'); timeline.max = String(snapshots.length - 1); timeline.value = String(replayIndex ?? snapshots.length - 1);
  timeline.disabled = events.length === 0;
  $('#return-live').hidden = replayIndex === null;
  $('#step').setAttribute('aria-disabled', String(state.waiting || state.finished));
  document.body.classList.toggle('paused', !running);
}
function stop() { running = false; clearTimeout(timer); }
function schedule() {
  clearTimeout(timer);
  if (running && !state.waiting && !state.finished && replayIndex === null) {
    const speed = Number($<HTMLSelectElement>('#speed').value);
    timer = setTimeout(() => { advance(); schedule(); }, 3100 / speed);
  }
}
function apply(event: StudioEvent): boolean {
  const result = reduceEvent(state, event);
  if (result.error) { stop(); $('#repo-feedback').textContent = result.error; return false; }
  state = result.state; events.push(event); snapshots.push(structuredClone(state));
  if (follow) selected = state.active;
  if (state.waiting || state.finished) stop();
  return true;
}
function advance() {
  if (state.waiting || state.finished || replayIndex !== null || !scenes[sceneIndex]) { render(); return; }
  if (apply(eventFor(scenes[sceneIndex], state.run, state.sequence + 1))) sceneIndex++;
  render();
}
function reset(autoplay = true) {
  stop(); runNumber++; state = initialState(repositories, `DEMO-${String(runNumber).padStart(3, '0')}`);
  scenes = scenario(repositories); sceneIndex = 0; events = []; snapshots = [structuredClone(state)];
  replayIndex = null; selected = 'plan'; follow = true; running = autoplay;
  advance(); schedule();
}
$('#play').addEventListener('click', () => {
  if (running) stop();
  else if (state.finished && replayIndex === null) reset();
  else { replayIndex = null; running = !state.waiting && !state.finished; schedule(); }
  render();
});
$('#step').addEventListener('click', () => { stop(); replayIndex = null; advance(); });
$('#reset').addEventListener('click', () => reset(running));
$('#speed').addEventListener('change', schedule);
$('#approve').addEventListener('click', () => {
  if (replayIndex !== null) return;
  if (apply(eventFor({ type: 'human.approve', message: 'Rozhodnutí člověka zaznamenáno pro aktuální revizi. Ukázka může pokračovat.' }, state.run, state.sequence + 1))) {
    running = true; render(); schedule();
  }
});
for (const name of ['detail', 'plan', 'memory', 'repos'] as const) {
  $(`#tab-${name}`).addEventListener('click', () => showPanel(name));
  $(`#tab-${name}`).addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const names: Panel[] = ['detail', 'plan', 'memory', 'repos'];
    const next = names[(names.indexOf(name) + (event.key === 'ArrowRight' ? 1 : 3)) % 4];
    showPanel(next); $(`#tab-${next}`).focus();
  });
}
$('#show-plan').addEventListener('click', () => showPanel('plan'));
for (const [button, lens] of [['process-view', 'process'], ['memory-view', 'memory']] as const) {
  $(`#${button}`).addEventListener('click', () => {
    graph.setLens(lens);
    for (const id of ['process-view', 'memory-view']) { $(`#${id}`).classList.toggle('active', id === button); $(`#${id}`).setAttribute('aria-pressed', String(id === button)); }
    if (lens === 'memory') showPanel('memory');
  });
}
$('#repo-form').addEventListener('submit', e => {
  e.preventDefault();
  if (replayIndex !== null) { $('#repo-feedback').textContent = 'Nejprve se vraťte k poslední události.'; return; }
  try {
    const repository = parseRepository($<HTMLInputElement>('#repo-url').value, $<HTMLSelectElement>('#repo-role').value, repositories);
    repositories = [...repositories, repository];
    $('#repo-feedback').textContent = `${repository.name} je zahrnut do nového modelového běhu. Skutečné připojení nevzniklo.`;
    $<HTMLInputElement>('#repo-url').value = '';
    reset(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (error) { $('#repo-feedback').textContent = error instanceof Error ? error.message : 'Repozitář nelze přidat.'; }
});
$('#repo-role').addEventListener('change', () => {
  const role = $<HTMLSelectElement>('#repo-role').value;
  $('#role-description').textContent = role === 'context' ? 'Přidá načtení zdrojů, jejich původ a ověření kontextu.' : role === 'module' ? 'Přidá předání vstupu, výstup modulu a společný test rozhraní.' : 'Přidá kontrolní službu a povinný výsledek do podmínek předání.';
});
$('#timeline').addEventListener('input', () => { stop(); replayIndex = Number($<HTMLInputElement>('#timeline').value); render(); });
$('#return-live').addEventListener('click', () => { replayIndex = null; render(); });
$('#export').addEventListener('click', () => {
  const data = { schemaVersion: 1, mode: 'simulation', run: state.run, repositories, events };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `opora-${state.run.toLowerCase()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
let resumeAfterDialog = false;
$('#about-open').addEventListener('click', () => {
  resumeAfterDialog = running; stop(); render(); $<HTMLDialogElement>('#about').showModal();
});
$('#about-close').addEventListener('click', () => $<HTMLDialogElement>('#about').close());
$('#about').addEventListener('close', () => { running = resumeAfterDialog && !state.waiting && !state.finished && replayIndex === null; render(); schedule(); });
window.addEventListener('pagehide', () => { clearTimeout(timer); motion.destroy(); });
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
advance(); schedule();
