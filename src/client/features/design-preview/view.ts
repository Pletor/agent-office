// The preview box of "Jak to bude vypadat": what the card looks like at a stage. The sketch (an SVG)
// and the screenshots (PNGs) are `<img>`s from the office's own proxy, never inline markup, so a
// sketch can't run a script. Review is a before/after slider: sketch × screenshot on a brand card,
// brand × new direction on an explore one.

import { h } from '../../ui/dom';
import { previewFileUrl, type OporaPreviewReply, type PreviewShot } from '../../../shared/opora-preview';
import { shownHead, STAGES } from './stage';

export interface ViewArgs {
  floor: string;
  card: string;
  r: OporaPreviewReply;
  stage: number;
  /** Where the slider was left (0–100), kept by the section across redraws. */
  cut: number;
  setCut: (v: number) => void;
}

const img = (src: string, alt: string, cls = 'dp-img') => h('img', { class: cls, src, alt, loading: 'lazy', decoding: 'async', draggable: 'false' });
const cap = (b: string, rest?: string) => h('p.dp-cap', {}, h('b', {}, b), rest ? h('span', {}, ` ${rest}`) : null);
const vp = (s: PreviewShot) => (s.width && s.height ? `${s.width}×${s.height}` : '');

function sketchImg(a: ViewArgs): HTMLElement {
  return img(previewFileUrl(a.floor, a.card, 'sketch'), 'Skica obrazovky z Opory', 'dp-img sk');
}

function shotFig(a: ViewArgs, s: PreviewShot): HTMLElement {
  return h('figure.dp-fr', {}, img(previewFileUrl(a.floor, a.card, 'shot', s.file), `Screenshot ${s.label}`), h('figcaption', {}, [s.label, vp(s)].filter(Boolean).join(' · ')));
}

/** A shot to compare: the one a person would look at first (phone, light), else the first. */
function mainShot(shots: PreviewShot[]): PreviewShot | undefined {
  return shots.find((s) => /mobil|phone|390/i.test(s.label) && !/tmav|dark/i.test(s.label)) ?? shots[0];
}

/** The before/after slider: `before` under, `after` clipped from the cut to the right. */
function slider(a: ViewArgs, before: HTMLElement, after: HTMLElement, tags: [string, string]): HTMLElement {
  const box = h('div.dp-ba');
  box.style.setProperty('--cut', `${a.cut}%`);
  const range = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(a.cut), 'aria-label': `Posuvník před / po: vlevo ${tags[0]}, vpravo ${tags[1]}` }) as HTMLInputElement;
  range.addEventListener('input', () => { box.style.setProperty('--cut', `${range.value}%`); a.setCut(Number(range.value)); });
  box.append(h('div.dp-ba-b', {}, before), h('div.dp-ba-a', {}, after), h('span.dp-ba-h', { 'aria-hidden': 'true' }),
    h('span.dp-tg.l', {}, tags[0]), h('span.dp-tg.r', {}, tags[1]), range);
  return box;
}

function review(a: ViewArgs): { src: string; body: Node[] } {
  const head = shownHead(a.r), shot = mainShot(head?.shots ?? []);
  const explore = a.r.mode === 'explore';
  if (!shot) return { src: explore ? 'brand × nový směr' : 'skica × screenshot', body: [a.r.sketch ? sketchImg(a) : h('div.dp-empty'), cap('Screenshoty zatím nejsou.', 'Srovnání před / po přijde s prvním screenshotem.')] };
  const after = img(previewFileUrl(a.floor, a.card, 'shot', shot.file), `Screenshot ${shot.label}`);
  if (explore) {
    // "Brand": the same view from an older head built by the brand, when Opora has one.
    const brandShot = a.r.heads.filter((x) => x !== head && x.mode === 'brand').flatMap((x) => x.shots).find((s) => s.label === shot.label);
    const before = brandShot ? img(previewFileUrl(a.floor, a.card, 'shot', brandShot.file), `Současný brand: ${brandShot.label}`) : a.r.sketch ? sketchImg(a) : null;
    if (!before) return { src: 'brand × nový směr', body: [shotFig(a, shot), cap('Není s čím porovnat.', 'Karta nemá skicu ani screenshot v současném brandu.')] };
    return { src: 'brand × nový směr', body: [slider(a, before, after, [brandShot ? 'současný brand' : 'skica', 'nový směr']),
      cap('Táhni posuvníkem:', `vlevo ${brandShot ? 'obrazovka v současném brandu' : 'skica'}, vpravo v novém směru (${shot.label}).`)] };
  }
  if (!a.r.sketch) return { src: 'screenshot', body: [shotFig(a, shot), cap('Není s čím porovnat.', 'Bez skici se shoda s návrhem ověřuje jen proti textu zadání.')] };
  return { src: 'skica × screenshot', body: [slider(a, sketchImg(a), after, ['návrh', 'výsledek']),
    cap('Táhni posuvníkem:', `vlevo skica, vpravo screenshot ze stejného commitu (${shot.label}).`)] };
}

/** The box's header (what and from where) and its body for the stage shown. */
export function preview(a: ViewArgs): HTMLElement {
  const head = shownHead(a.r), shots = head?.shots ?? [];
  const sha = head?.headSha ? `head ${head.headSha.slice(0, 7)}` : '';
  let src = '', body: Node[];
  switch (a.stage) {
    case 0:
      body = [cap('Zatím jen zadání.', 'Další etapa přidá skicu obrazovky.')];
      break;
    case 1:
    case 2: {
      const moments = a.r.storyboard?.moments;
      src = a.stage === 2 && moments ? 'storyboard' : 'skica';
      body = a.r.sketch ? [sketchImg(a)] : [h('div.dp-empty', { 'aria-hidden': 'true' })];
      if (a.stage === 2 && moments) body.push(cap(`Storyboard · ${moments} ${moments === 1 ? 'moment' : moments < 5 ? 'momenty' : 'momentů'}.`, 'Snímky pohybu jsou v Opoře.'));
      else body.push(a.r.sketch ? cap('Takhle to člověk nakreslil.', a.r.drawing ? `${a.r.drawing.elements} prvků na skice.` : undefined) : cap('Karta zatím nemá skicu.', 'Designér bude stavět jen podle textu zadání.'));
      break;
    }
    case 3:
      src = shots.length ? sha : a.r.sketch ? 'skica' : '';
      body = shots.length ? [shotFig(a, mainShot(shots)!), cap('Rozpracováno:', 'průběžný screenshot.')]
        : [a.r.sketch ? sketchImg(a) : h('div.dp-empty', { 'aria-hidden': 'true' }), cap('Staví se.', 'Screenshoty přijdou s kontrolami.')];
      break;
    case 4:
      src = sha;
      body = shots.length ? [h('div.dp-grid', {}, ...shots.slice(0, 4).map((s) => shotFig(a, s))), cap(`${shots.length} ${shots.length === 1 ? 'screenshot' : shots.length < 5 ? 'screenshoty' : 'screenshotů'}`, shots.length > 4 ? `(+${shots.length - 4} v Opoře)` : 'ze stejného commitu.')]
        : [cap('Screenshoty zatím nejsou.', 'Designér je pošle s výsledkem.')];
      break;
    case 5: {
      const r = review(a);
      src = r.src; body = r.body;
      break;
    }
    default: {
      src = sha;
      const shot = mainShot(shots);
      body = shot ? [shotFig(a, shot)] : [];
      body.push(head?.confirmed ? cap('Vzhled potvrzen člověkem.', 'Screenshoty zůstávají u karty.') : cap('Karta je uzavřená.', 'Potvrzení vzhledu je v Opoře.'));
    }
  }
  return h('div.dp-pv', {}, h('div.dp-pv-h', {}, h('span.what', {}, STAGES[a.stage].what), src ? h('span.src', {}, src) : null), h('div.dp-pv-b', {}, ...body));
}
