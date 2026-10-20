// The least of a DOM that the office's `h()` helper (src/client/ui/dom.ts) and a panel built with it need
// to render under node: elements with attributes, children, text and the few queries the panels make.
// It is not a browser: layout, events on real input and CSS are what the *.browser.mjs scripts check.
// A test installs it with `installFakeDom()` before importing a client module (dynamic import), and
// reads the rendered tree back through `textOf`, `attr` and `find`.

export class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | undefined;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, EventListener[]>();
  value = '';
  disabled = false;
  open = false;
  private text = '';
  constructor(readonly tagName: string, text = '') { this.text = text; }
  get isText() { return this.tagName === '#text'; }
  get className() { return this.attributes.get('class') ?? ''; }
  set className(v: string) { this.attributes.set('class', v); }
  get hidden() { return this.attributes.has('hidden'); }
  set hidden(v: boolean) { if (v) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }
  get textContent(): string { return this.isText ? this.text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = []; if (v) this.append(new FakeNode('#text', String(v))); }
  setAttribute(k: string, v: string) { this.attributes.set(k, String(v)); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  addEventListener(type: string, fn: EventListener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  append(...nodes: (FakeNode | string)[]) { for (const n of nodes) { const node = typeof n === 'string' ? new FakeNode('#text', n) : n; node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: (FakeNode | string)[]) { this.children = []; this.append(...nodes); }
  /** Descendants, depth first. */
  *walk(): Generator<FakeNode> { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelector(selector: string): FakeNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): FakeNode[] {
    const [, tag, cls] = /^([a-z0-9]*)(?:\.([\w-]+))?$/i.exec(selector) ?? [];
    return [...this.walk()].filter((n) => !n.isText && (!tag || n.tagName === tag.toLowerCase()) && (!cls || n.className.split(/\s+/).includes(cls)));
  }
}

export function installFakeDom() {
  const g = globalThis as unknown as { document: unknown; Node: unknown; HTMLElement: unknown };
  g.Node = FakeNode;
  g.HTMLElement = FakeNode;
  g.document = {
    createElement: (tag: string) => new FakeNode(tag.toLowerCase()),
    createTextNode: (text: string) => new FakeNode('#text', text),
    getElementById: () => null,
    body: new FakeNode('body'),
  };
}
/** The text of the cells of each row of a table's body: what a reader sees. */
export function rows(table: FakeNode): string[][] {
  return (table.querySelector('tbody')?.children ?? []).filter((tr) => tr.tagName === 'tr').map((tr) => tr.children.filter((td) => td.tagName === 'td').map((td) => td.textContent));
}
/** The first element whose own text is exactly `text`. */
export function byText(root: FakeNode, text: string): FakeNode | undefined {
  return [...root.walk()].find((n) => !n.isText && n.children.some((c) => c.isText && c.textContent === text));
}
