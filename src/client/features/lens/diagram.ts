// The Lens diagram in the card inspector: lanes as bands, cards as buttons, edges in one SVG, laid
// out by layout.ts for the section's width. Hover or focus dims what's unrelated, a click opens the
// card's popover, "Projít tok" steps through a flow with a dot running along the active edge, and
// three switches show code edges, only changes, and file paths. The spec comes from Opora and agents
// wrote it: every string goes into the page as text (textContent), never as markup.
//
// The inspector is in a modal whose Esc returns to mouse-look. Esc closes an open popover or the
// playback first and stops there; only when neither is open does it reach the window.

import { h } from '../../ui/dom';
import type { LensGraph, LensNode, LensStep, PlanLens } from '../../../shared/opora-lens';
import { K, layoutLens, type LayoutOpts, type LensLayout } from './layout';
import { cardClass, DELTA, deltaMark, edgeClass, legend, planStatus, progress, s, shownBadges, STATUS, textList, type Mode } from './parts';
import { popover } from './popover';
import './diagram.css';

const AUTO_MS = 2400;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The diagrams in the page, for the Esc that has to reach them before the window's own. */
const live = new Set<LensDiagram>();
let keysOn = false;

/** One capture listener on the window, added before any window opens, so it runs ahead of the modal's Esc. */
export function listenForLensEsc() {
  if (keysOn) return;
  keysOn = true;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const d of live) {
      if (d.root.isConnected && d.escape()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    }
  }, true);
}

interface EdgeEl { g: SVGGElement; p: SVGPathElement; lbl: HTMLElement | null }

export class LensDiagram {
  readonly root = h('div.lx');
  private opt: LayoutOpts;
  private flows;
  private names = new Map<string, LensNode>();
  private width = 0;
  private flow = 0;
  private step = -1;
  private auto?: ReturnType<typeof setInterval>;
  private raf = 0;
  private pop?: { id: string; el: HTMLElement };
  private L!: LensLayout;
  private dg!: HTMLElement;
  private dot!: SVGCircleElement;
  private cap?: HTMLElement;
  private edgeEls: EdgeEl[] = [];
  private cardEls = new Map<string, HTMLButtonElement>();
  private ro?: ResizeObserver;

  constructor(private g: LensGraph, private mode: Mode, private plan?: PlanLens) {
    this.opt = { code: mode === 'plan', changed: false, files: false };
    this.flows = g.flows.filter((f) => f.steps.length);
    for (const l of g.lanes) for (const n of l.nodes) if (!this.names.has(n.id)) this.names.set(n.id, n);
    this.root.addEventListener('keydown', (e) => this.key(e));
    live.add(this);
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver((entries) => {
        const w = Math.floor(entries[entries.length - 1].contentRect.width);
        if (w > 0 && w !== this.width) requestAnimationFrame(() => this.setWidth(w));
      });
      this.ro.observe(this.root);
    }
  }

  destroy() {
    this.toggleAuto(false);
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    live.delete(this);
  }

  /** Lays out again for a new width (the section's content box). */
  setWidth(w: number) {
    if (w === this.width) return;
    this.width = w;
    this.render();
  }

  /** Esc: closes the popover, else the playback; false when there was neither (the window's turn). */
  escape(): boolean {
    if (this.pop) { this.closePop(); return true; }
    if (this.step >= 0) { this.stop(); return true; }
    return false;
  }

  private name = (id: string) => this.names.get(id)?.label ?? id;

  private render() {
    if (!this.width) return;
    const hadPop = this.pop?.id;
    this.pop = undefined;
    this.L = layoutLens(this.g, this.width, this.opt);
    const parts: Node[] = [];
    const prog = this.mode === 'plan' && this.plan ? progress(this.plan) : null;
    if (prog) parts.push(prog);
    parts.push(this.controls());
    if (this.step >= 0) parts.push(this.playBar());
    parts.push(this.diagram(), legend(this.mode, this.L, this.opt.code), textList(this.L, this.name));
    this.root.replaceChildren(...parts);
    requestAnimationFrame(() => this.clampLabels());
    if (this.step >= 0) this.showStep();
    else if (hadPop && this.cardEls.has(hadPop)) this.openPop(hadPop, false);
  }

  private controls(): HTMLElement {
    const sw = (key: keyof LayoutOpts, label: string) => h('button.lx-sw', {
      type: 'button', role: 'switch', 'aria-checked': String(this.opt[key]), 'data-sw': key,
      onclick: () => { this.opt[key] = !this.opt[key]; this.render(); this.root.querySelector<HTMLElement>(`[data-sw="${key}"]`)?.focus(); },
    }, h('span.tr', { 'aria-hidden': 'true' }), label);
    const ctl = h('div.lx-ctl');
    if (this.flows.length) {
      if (this.step < 0) ctl.append(h('button.lx-btn.go', { type: 'button', onclick: () => this.go(0) }, h('span.tri', { 'aria-hidden': 'true' }), 'Projít tok'));
      if (this.flows.length > 1) {
        ctl.append(h('div.lx-flowpick', { role: 'group', 'aria-label': 'Tok' }, ...this.flows.map((f, i) => h('button.lx-chip', {
          type: 'button', 'aria-pressed': String(i === this.flow), onclick: () => { this.flow = i; if (this.step >= 0) this.step = 0; this.render(); },
        }, f.title))));
      }
    }
    const sws = h('div.lx-sws', {}, sw('code', 'Vazby z kódu'), sw('changed', 'Jen změny'), sw('files', 'Cesty souborů'));
    return h('div.lx-top', {}, ctl.childNodes.length ? ctl : null, sws);
  }

  private playBar(): HTMLElement {
    const f = this.flows[this.flow], n = f.steps.length;
    this.cap = h('div.lx-cap', { 'aria-live': 'polite' });
    const pips = h('div.lx-pips', {}, ...f.steps.map((_, i) => h('button.lx-pip', {
      type: 'button', class: i < this.step ? 'done' : i === this.step ? 'cur' : '', 'aria-label': `Krok ${i + 1}`, 'aria-current': i === this.step ? 'step' : undefined, onclick: () => this.go(i),
    })));
    const auto = this.auto ? 'Pozastavit' : 'Přehrát samo';
    return h('div.lx-play', { role: 'region', 'aria-label': 'Procházení toku' },
      h('div.lx-play-h', {}, h('span.no', {}, `${this.step + 1} / ${n}`), h('span.ft', {}, f.title),
        h('button.lx-btn.x', { type: 'button', 'aria-label': 'Ukončit procházení', title: 'Ukončit (Esc)', onclick: () => this.stop() }, '✕')),
      this.cap, pips,
      h('div.lx-nav', {},
        h('button.lx-btn', { type: 'button', disabled: this.step === 0, 'data-nav': 'prev', onclick: () => this.go(this.step - 1) }, '◀ Zpět'),
        h('button.lx-btn.auto', { type: 'button', 'aria-pressed': String(!!this.auto), 'aria-label': auto, title: auto, 'data-nav': 'auto', onclick: () => this.toggleAuto() }, this.auto ? '❚❚' : '▶'),
        h('button.lx-btn', { type: 'button', disabled: this.step === n - 1, 'data-nav': 'next', onclick: () => this.go(this.step + 1) }, 'Další ▶')));
  }

  private diagram(): HTMLElement {
    const L = this.L;
    const dg = (this.dg = h('div.lx-dg', { style: `height:${L.H}px`, role: 'group', 'aria-label': `Diagram: ${this.g.title}` }));
    for (const b of L.bands) dg.append(h('div.lx-band', { style: `top:${b.y}px;height:${b.h}px` }));
    const svg = s('svg', { class: 'lx-svg', width: L.W, height: L.H, viewBox: `0 0 ${L.W} ${L.H}`, 'aria-hidden': 'true' });
    dg.append(svg);
    for (const b of L.bands) dg.append(h('div.lx-lane', { style: `top:${b.y + 4}px;left:${K.PADX}px` }, b.lane.label));
    this.edgeEls = [];
    for (const e of L.edges) {
      const cls = edgeClass(e.e, this.mode, (id) => this.names.get(id));
      const g = s('g', { class: `lx-e ${cls}` });
      const p = s('path', { class: 'ln', d: e.d });
      g.append(p, s('path', { class: 'ah', d: e.head }));
      svg.append(g);
      const lbl = e.e.label ? h('div', { class: `lx-lbl ${cls}`, style: `left:${e.label.x}px;top:${e.label.y}px;max-width:${Math.round(L.W * 0.62)}px` }, e.e.label) : null;
      if (lbl) { lbl.dataset.x = String(e.label.x); dg.append(lbl); }
      this.edgeEls.push({ g, p, lbl });
    }
    this.dot = s('circle', { class: 'lx-dot', r: 5.5, cx: -20, cy: -20, visibility: 'hidden' });
    svg.append(this.dot);
    this.cardEls = new Map();
    for (const v of L.nodes) {
      const n = v.n, badges = shownBadges(n, this.mode);
      const ins = L.edges.filter((e) => e.e.to === n.id).length, outs = L.edges.filter((e) => e.e.from === n.id).length;
      const state = this.mode === 'plan' ? STATUS[planStatus(n)] : DELTA[n.delta][1];
      const file = this.opt.files ? n.files[0] : undefined;
      const c = h('button.lx-card', {
        type: 'button', class: `${cardClass(n, this.mode)}${v.ghost ? ' ghost' : ''}`, style: `left:${v.x}px;top:${v.y}px;width:${v.w}px;height:${v.h}px`,
        'aria-label': `${n.label}, ${n.kind}, ${state}, vstupy ${ins}, výstupy ${outs}`, 'aria-haspopup': 'dialog',
        onclick: () => this.openPop(n.id), onmouseenter: () => this.hover(n.id), onmouseleave: () => this.hover(null), onfocus: () => this.hover(n.id), onblur: () => this.hover(null),
      },
      h('b.t', {}, n.label),
      h('span.m', {}, deltaMark(n.delta), h('span.kd', {}, n.kind), badges[0] ? h('span.bd', {}, badges[0]) : null,
        badges.length > 1 ? h('span.bd.more', { title: badges.slice(1).join(', ') }, `+${badges.length - 1}`) : null),
      file ? h('span.f', { title: file.path }, `‎${file.path}${file.lines ? ':' + file.lines : ''}‎`) : null);
      this.cardEls.set(n.id, c);
      dg.append(c);
    }
    if (!L.nodes.length) dg.append(h('span.pw-note', {}, 'Nic k zobrazení — zkus vypnout „Jen změny“.'));
    return dg;
  }

  /** Labels are centred on their run, then pushed back inside the diagram once their width is known. */
  private clampLabels() {
    for (const { lbl } of this.edgeEls) {
      if (!lbl || !lbl.isConnected) continue;
      const w = lbl.offsetWidth, x = Number(lbl.dataset.x);
      lbl.style.left = `${Math.max(w / 2 + 2, Math.min(this.L.W - w / 2 - 2, x))}px`;
    }
  }

  // ---- highlight: hover, popover, playback ----

  private mark(nodes: Set<string> | null, edges: Set<number> | null, cur?: Set<string>) {
    this.dg.classList.toggle('focus', !!(nodes || edges));
    for (const [id, c] of this.cardEls) { c.classList.toggle('on', !!nodes?.has(id)); c.classList.toggle('cur', !!cur?.has(id)); }
    this.edgeEls.forEach((x, i) => {
      const hit = !!edges?.has(i);
      x.g.classList.toggle('on', hit); x.g.classList.toggle('cur', hit && !!cur);
      x.lbl?.classList.toggle('on', hit); x.lbl?.classList.toggle('cur', hit && !!cur);
    });
  }

  private around(id: string): [Set<string>, Set<number>] {
    const ns = new Set([id]), es = new Set<number>();
    this.L.edges.forEach((e, i) => { if (e.e.from === id || e.e.to === id) { es.add(i); ns.add(e.e.from); ns.add(e.e.to); } });
    return [ns, es];
  }

  private hover(id: string | null) {
    if (this.step >= 0) return;
    const at = id ?? this.pop?.id;
    if (at) this.mark(...this.around(at)); else this.mark(null, null);
  }

  // ---- popover ----

  private openPop(id: string, focus = true) {
    this.closePop(false);
    const n = this.names.get(id), v = this.L.nodes.find((x) => x.n.id === id);
    if (!n || !v) return;
    const { el, x } = popover({
      n, mode: this.mode, name: this.name, close: () => this.closePop(),
      ins: this.L.edges.filter((e) => e.e.to === id), outs: this.L.edges.filter((e) => e.e.from === id),
      go: (other) => { if (this.cardEls.has(other)) this.openPop(other); },
    });
    const W = this.L.W, pw = Math.min(W, 300);
    el.style.width = `${pw}px`;
    el.style.left = `${Math.max(0, Math.min(W - pw, v.x + v.w / 2 - pw / 2))}px`;
    el.style.top = `${v.y + v.h + 8}px`;
    this.dg.append(el);
    // Above the card when it would run past the diagram's end and there's room above.
    if (v.y + v.h + 8 + el.offsetHeight > this.L.H + 40 && v.y - 8 - el.offsetHeight >= 0) el.style.top = `${v.y - 8 - el.offsetHeight}px`;
    this.dg.style.minHeight = `${Math.max(this.L.H, el.offsetTop + el.offsetHeight + 8)}px`;
    this.pop = { id, el };
    if (this.step < 0) this.mark(...this.around(id));
    if (focus) x.focus({ preventScroll: true });
  }

  private closePop(refocus = true) {
    if (!this.pop) return;
    const { id, el } = this.pop;
    el.remove();
    this.pop = undefined;
    this.dg.style.minHeight = '';
    if (this.step < 0) this.mark(null, null);
    const card = this.cardEls.get(id);
    if (refocus && card?.isConnected) card.focus({ preventScroll: true });
  }

  // ---- playback ----

  private go(i: number) {
    const n = this.flows[this.flow].steps.length;
    const was = (document.activeElement as HTMLElement | null)?.dataset?.nav;
    this.step = Math.max(0, Math.min(n - 1, i));
    this.closePop(false);
    this.render();
    const nav = this.step === n - 1 ? 'prev' : was === 'prev' && this.step > 0 ? 'prev' : was === 'auto' ? 'auto' : 'next';
    this.root.querySelector<HTMLElement>(`[data-nav="${nav}"]`)?.focus({ preventScroll: true });
  }

  private stop() {
    this.step = -1;
    this.toggleAuto(false);
    cancelAnimationFrame(this.raf);
    this.render();
    this.root.querySelector<HTMLElement>('.lx-btn.go')?.focus({ preventScroll: true });
  }

  private toggleAuto(force?: boolean) {
    const want = force ?? !this.auto;
    clearInterval(this.auto);
    this.auto = undefined;
    if (want && this.step >= 0) {
      this.auto = setInterval(() => {
        if (!this.root.isConnected) { this.toggleAuto(false); return; }
        if (this.step >= this.flows[this.flow].steps.length - 1) { this.toggleAuto(false); this.render(); return; }
        this.go(this.step + 1);
      }, AUTO_MS);
    }
    if (this.step >= 0 && force === undefined) {
      this.render();
      this.root.querySelector<HTMLElement>('[data-nav="auto"]')?.focus({ preventScroll: true });
    }
  }

  private showStep() {
    const st: LensStep = this.flows[this.flow].steps[this.step];
    const L = this.L;
    let ei = -1;
    if (st.from && st.to) {
      ei = L.edges.findIndex((e) => e.e.from === st.from && e.e.to === st.to);
      if (ei < 0) ei = L.edges.findIndex((e) => e.e.from === st.to && e.e.to === st.from);
    }
    const ns = new Set([st.from, st.to].filter((id): id is string => !!id && this.cardEls.has(id)));
    this.mark(ns, new Set(ei >= 0 ? [ei] : []), ns);
    const cap: (Node | string)[] = [];
    if (st.from && st.to) cap.push(h('b', {}, this.name(st.from)), ' → ', h('b', {}, this.name(st.to)), h('br'));
    if (st.label) cap.push(h('span.via', {}, st.label));
    if (st.from && st.to && ei < 0) cap.push(h('span.hid', {}, 'Tahle vazba v diagramu není nebo je skrytá přepínačem.'));
    this.cap?.replaceChildren(...cap);
    this.runDot(ei >= 0 ? this.edgeEls[ei].p : null, st.to ? this.cardEls.get(st.to) : undefined);
    this.reveal(ns);
  }

  private runDot(path: SVGPathElement | null, target?: HTMLElement) {
    cancelAnimationFrame(this.raf);
    if (!path || typeof path.getTotalLength !== 'function') { this.dot.setAttribute('visibility', 'hidden'); return; }
    const len = path.getTotalLength();
    const put = (t: number) => { const p = path.getPointAtLength(len * t); this.dot.setAttribute('cx', String(p.x)); this.dot.setAttribute('cy', String(p.y)); };
    this.dot.setAttribute('visibility', 'visible');
    if (reduced()) { put(1); return; }
    const t0 = performance.now(), dur = Math.min(1500, 500 + len * 2.2);
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      put(e);
      if (k < 1) this.raf = requestAnimationFrame(tick);
      else if (target) { target.classList.remove('arrive'); void target.offsetWidth; target.classList.add('arrive'); }
    };
    put(0);
    this.raf = requestAnimationFrame(tick);
  }

  /** Keeps the step's cards inside the inspector's scroll box (no scrollIntoView, which would move the window). */
  private reveal(ns: Set<string>) {
    const box = this.root.closest('.pw-scroll');
    if (!box || !ns.size) return;
    const ys = this.L.nodes.filter((v) => ns.has(v.n.id));
    const top = Math.min(...ys.map((v) => v.y)), bot = Math.max(...ys.map((v) => v.y + v.h));
    const off = this.dg.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const bar = this.root.querySelector<HTMLElement>('.lx-play')?.offsetHeight ?? 0;
    if (off + top - bar - 8 < box.scrollTop) box.scrollTop = off + top - bar - 8;
    else if (off + bot + 8 > box.scrollTop + box.clientHeight) box.scrollTop = off + bot + 8 - box.clientHeight;
  }

  private key(e: KeyboardEvent) {
    if (this.step < 0 || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    if ((e.target as HTMLElement | null)?.closest?.('.lx-pop')) return;
    e.preventDefault();
    e.stopPropagation();
    this.go(this.step + (e.key === 'ArrowRight' ? 1 : -1));
  }
}
