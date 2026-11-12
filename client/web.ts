import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import type { EditorState, Transaction } from "@codemirror/state";
import type { EditorView, EditorViewConfig, Tooltip } from "@codemirror/view";
import { Platform } from "react-native";
import type { AskMode } from "../shared/explain";
import {
  fromSuperscript,
  isKept,
  MARK_CLOSE,
  MARK_OPEN,
  type Mark,
  superscript,
  type TextRange,
} from "../shared/markdown";
import { findMatches } from "../shared/search";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface DomEvent {
  type: string;
  clientX: number;
  clientY: number;
  target?: unknown;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation?(): void;
  stopImmediatePropagation?(): void;
}
type DomListener = (event: DomEvent) => void;
interface DomEvents {
  addEventListener(type: string, listener: DomListener, capture?: boolean): void;
  removeEventListener(type: string, listener: DomListener, capture?: boolean): void;
}
interface DomButton extends DomEvents {
  className: string;
  textContent: string | null;
  type: string;
}
interface DomDiv {
  className: string;
  appendChild(child: unknown): void;
}
interface DomRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}
interface DomElement extends DomEvents {
  contains(node: unknown): boolean;
  getBoundingClientRect(): DomRect;
}
interface DomText {
  nodeType: number;
  textContent: string | null;
  parentElement: { scrollIntoView(options: { block: string; behavior: string }): void } | null;
}
interface DomRange {
  startContainer: unknown;
  startOffset: number;
  commonAncestorContainer: unknown;
  toString(): string;
  getClientRects(): ArrayLike<DomRect>;
  getBoundingClientRect(): DomRect;
  selectNodeContents(node: unknown): void;
  setStart(node: unknown, offset: number): void;
  setEnd(node: unknown, offset: number): void;
  cloneRange(): DomRange;
}
interface DomSelection {
  rangeCount: number;
  isCollapsed: boolean;
  getRangeAt(index: number): DomRange;
}
declare const document: DomEvents & {
  createElement(tag: "button"): DomButton;
  createElement(tag: "div"): DomDiv;
  createRange(): DomRange;
  getSelection(): DomSelection | null;
  caretRangeFromPoint?(x: number, y: number): DomRange | null;
  createElement(tag: "style"): DomStyle;
  createTreeWalker(root: unknown, whatToShow: number): { nextNode(): DomText | null };
  head: { appendChild(child: unknown): void };
};
interface DomStyle {
  textContent: string | null;
  remove(): void;
}
declare const window: DomEvents;
declare function requestAnimationFrame(callback: () => void): number;
declare function cancelAnimationFrame(handle: number): void;
declare class MutationObserver {
  constructor(callback: () => void);
  observe(target: unknown, options: { childList?: boolean; subtree?: boolean; characterData?: boolean }): void;
  disconnect(): void;
}

const TEXT_NODE = 3;
const SHOW_TEXT = 4;
const SUPERSCRIPT_DIGIT = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/;
const MARK_COLOR = "rgba(255, 212, 0, 0.38)";
const HOVER_SLACK = 3;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
interface HighlightGlobals {
  CSS?: { highlights?: HighlightRegistry };
  Highlight?: new (...ranges: DomRange[]) => { priority: number };
}

/** A hovered footnote: its number and where to float its tooltip. */
export interface FootnoteHover {
  number: number;
  /** Position relative to the overlay's top-left corner: the left edge and just below the text. */
  left: number;
  top: number;
  /** Distance from the overlay's bottom edge to just above the text, for placing it above. */
  bottom: number;
  /** Overlay size, so the tooltip can stay inside it. */
  width: number;
  height: number;
}

export interface PreviewDecorations {
  /** Paints `marks` (in document order) as highlights; linked marks show their note on hover. */
  setMarks(marks: readonly Mark[]): void;
  /**
   * Scrolls footnote `number` into view, at its highlight or else its superscript, and flashes
   * it. Waits for a pending repaint. Reports whether it was found.
   */
  reveal(number: number): Promise<boolean>;
  dispose(): void;
}

const FLASH_COLOR = "rgba(255, 170, 0, 0.75)";
const FLASH_MS = 1400;

/** A CSS highlight is set-like: decorations add and remove their own ranges. */
interface SharedHighlight {
  add(range: DomRange): unknown;
  delete(range: DomRange): boolean;
  priority: number;
}

const SHARED_HIGHLIGHTS = { "doc-ask-mark": MARK_COLOR, "doc-ask-flash": FLASH_COLOR } as const;
type SharedHighlightName = keyof typeof SHARED_HIGHLIGHTS;
const sharedHighlights = new Map<SharedHighlightName, SharedHighlight>();
let sharedHighlightStyle = false;

/**
 * One highlight per kind for every decorated view, so the page gets a single style element
 * however many messages or documents are on screen. Null without the Custom Highlight API.
 */
function sharedHighlight(name: SharedHighlightName): SharedHighlight | null {
  const globals = globalThis as HighlightGlobals;
  const registry = globals.CSS?.highlights;
  if (!registry || !globals.Highlight) return null;
  if (!sharedHighlightStyle) {
    const style = document.createElement("style");
    style.textContent = Object.entries(SHARED_HIGHLIGHTS)
      .map(([kind, color]) => `::highlight(${kind}) { background-color: ${color}; }`)
      .join(" ");
    document.head.appendChild(style);
    sharedHighlightStyle = true;
  }
  let highlight = sharedHighlights.get(name);
  if (!highlight) {
    highlight = new globals.Highlight() as unknown as SharedHighlight;
    // A flash paints over the plain highlight.
    if (name === "doc-ask-flash") highlight.priority = 1;
    registry.set(name, highlight);
    sharedHighlights.set(name, highlight);
  }
  return highlight;
}

/**
 * Decorates rendered Markdown inside `container` without touching its DOM: paints highlights
 * through the CSS Custom Highlight API, and reports the footnote under the pointer, whether the
 * pointer is on a superscript reference or on a highlight linked to a footnote. Hover positions
 * are relative to `overlay`, the element the tooltip is drawn in.
 */
export function decoratePreview(
  container: unknown,
  overlay: unknown,
  onHover: (hover: FootnoteHover | null) => void,
  onOpen: (number: number) => void,
): PreviewDecorations {
  const none: PreviewDecorations = { setMarks() {}, reveal: async () => false, dispose() {} };
  if (Platform.OS !== "web" || !container || !overlay) return none;
  const root = container as DomElement;
  const overlayElement = overlay as DomElement;

  let marks: readonly Mark[] = [];
  let painted: LocatedMark[] = [];
  let frame = 0;

  const unpaint = () => {
    const highlight = painted.length > 0 ? sharedHighlight("doc-ask-mark") : null;
    for (const mark of painted) highlight?.delete(mark.range);
    painted = [];
  };
  // Reveals wait for the next paint so they see the newest DOM.
  let afterPaint: (() => void)[] = [];
  const paint = () => {
    frame = 0;
    unpaint();
    painted = locateMarks(root, marks);
    const highlight = painted.length > 0 ? sharedHighlight("doc-ask-mark") : null;
    for (const mark of painted) highlight?.add(mark.range);
    const waiting = afterPaint;
    afterPaint = [];
    for (const run of waiting) run();
  };

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let flashed: DomRange | null = null;
  const unflash = () => {
    if (flashed) sharedHighlight("doc-ask-flash")?.delete(flashed);
    flashed = null;
  };
  const flash = (range: DomRange) => {
    unflash();
    sharedHighlight("doc-ask-flash")?.add(range);
    flashed = range;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(unflash, FLASH_MS);
  };
  /** The footnote's highlight, or else its first superscript reference. */
  const rangeOf = (number: number): DomRange | null => {
    const mark = painted.find((m) => m.number === number);
    if (mark) return mark.range;
    const target = superscript(number);
    const walker = document.createTreeWalker(root, SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let i = text.indexOf(target); i !== -1; i = text.indexOf(target, i + 1)) {
        // The whole run must be this number, not part of a longer one.
        if (SUPERSCRIPT_DIGIT.test(text[i - 1] ?? "") || SUPERSCRIPT_DIGIT.test(text[i + target.length] ?? "")) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + target.length);
        return range;
      }
    }
    return null;
  };
  const revealNow = (number: number) => {
    const range = rangeOf(number);
    const element = (range?.startContainer as DomText | undefined)?.parentElement;
    if (!range || !element) return false;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    flash(range);
    return true;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  // The renderer may update the DOM after React commits; repaint whenever it changes. Watched
  // only while there is something to paint: most views have no highlights.
  let observer: MutationObserver | null = null;
  const observe = (needed: boolean) => {
    if (needed && !observer) {
      observer = new MutationObserver(schedule);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    } else if (!needed && observer) {
      observer.disconnect();
      observer = null;
    }
  };

  // Keyed by footnote only: moving between a highlight, its other lines and its superscript keeps
  // the tooltip where it first opened.
  let last: number | null = null;
  const report = (hover: FootnoteHover | null) => {
    const key = hover ? hover.number : null;
    if (key === last) return;
    last = key;
    onHover(hover);
  };
  const within = (rect: DomRect, x: number, y: number) =>
    x >= rect.left - HOVER_SLACK &&
    x <= rect.right + HOVER_SLACK &&
    y >= rect.top - HOVER_SLACK &&
    y <= rect.bottom + HOVER_SLACK;
  const hoverAt = (rect: DomRect, number: number): FootnoteHover => {
    const box = overlayElement.getBoundingClientRect();
    return {
      number,
      left: Math.max(0, rect.left - box.left - 12),
      top: rect.bottom - box.top + 4,
      bottom: box.bottom - rect.top + 4,
      width: box.right - box.left,
      height: box.bottom - box.top,
    };
  };

  /** The footnote under the point: a linked highlight with its reference, or a superscript. */
  /** The superscript number under the point, exactly; several numbers can follow one passage. */
  const superscriptAt = (x: number, y: number): { number: number; rect: DomRect } | null => {
    const caret = document.caretRangeFromPoint?.(x, y);
    const node = caret?.startContainer as DomText | undefined;
    if (!caret || !node || node.nodeType !== TEXT_NODE || !root.contains(node)) return null;
    const text = node.textContent ?? "";
    let start = caret.startOffset;
    if (!SUPERSCRIPT_DIGIT.test(text[start] ?? "")) start--;
    if (!SUPERSCRIPT_DIGIT.test(text[start] ?? "")) return null;
    let end = start + 1;
    while (start > 0 && SUPERSCRIPT_DIGIT.test(text[start - 1])) start--;
    while (end < text.length && SUPERSCRIPT_DIGIT.test(text[end])) end++;
    const run = document.createRange();
    run.setStart(node, start);
    run.setEnd(node, end);
    const rect = run.getBoundingClientRect();
    return within(rect, x, y) ? { number: fromSuperscript(text.slice(start, end)), rect } : null;
  };
  /** The footnote under the point: a superscript first, else a linked highlight. */
  const footnoteAt = (x: number, y: number): { number: number; rect: DomRect } | null => {
    const exact = superscriptAt(x, y);
    if (exact) return exact;
    for (const mark of painted) {
      if (mark.number === null) continue;
      const rects = mark.hoverRange.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        if (within(rects[i], x, y)) return { number: mark.number, rect: rects[i] };
      }
    }
    return null;
  };

  const move: DomListener = (event) => {
    const hit = footnoteAt(event.clientX, event.clientY);
    report(hit ? hoverAt(hit.rect, hit.number) : null);
  };
  const leave: DomListener = () => report(null);
  // A plain click opens the footnote; a click that ends a drag selection does not.
  const click: DomListener = (event) => {
    if (document.getSelection()?.isCollapsed === false) return;
    const hit = footnoteAt(event.clientX, event.clientY);
    if (hit) onOpen(hit.number);
  };
  root.addEventListener("mousemove", move);
  root.addEventListener("mouseleave", leave);
  root.addEventListener("click", click);

  return {
    setMarks(next) {
      // Nothing painted and nothing to paint: skip the work entirely.
      if (next.length === 0 && marks.length === 0 && painted.length === 0) return;
      marks = next;
      observe(next.length > 0);
      schedule();
    },
    reveal(number) {
      if (!frame) return Promise.resolve(revealNow(number));
      return new Promise((resolve) => afterPaint.push(() => resolve(revealNow(number))));
    },
    dispose() {
      observe(false);
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener("mousemove", move);
      root.removeEventListener("mouseleave", leave);
      root.removeEventListener("click", click);
      unpaint();
      unflash();
      if (flashTimer) clearTimeout(flashTimer);
      for (const run of afterPaint) run();
      afterPaint = [];
    },
  };
}

const SEARCH_COLOR = "rgba(64, 156, 255, 0.35)";
const SEARCH_CURRENT_COLOR = "rgba(255, 140, 0, 0.7)";

export interface PreviewSearch {
  /** Highlights every match of `query`, marks match `index` as current, and scrolls to it. */
  update(query: string, index: number): void;
  dispose(): void;
}

let searchCount = 0;

/**
 * Finds text in rendered Markdown inside `container` and paints the matches through the CSS
 * Custom Highlight API, leaving the DOM alone. Matches are found again whenever the rendering
 * changes; `onCount` hears the number of matches after every search.
 */
export function searchPreview(container: unknown, onCount: (count: number) => void): PreviewSearch {
  const none: PreviewSearch = { update() {}, dispose() {} };
  if (Platform.OS !== "web" || !container) return none;
  const root = container as DomElement;
  const globals = globalThis as HighlightGlobals;
  const registry = globals.CSS?.highlights;
  const Highlight = globals.Highlight;
  if (!registry || !Highlight) return none;
  const name = `doc-ask-search-${++searchCount}`;
  const currentName = `${name}-current`;
  const style = document.createElement("style");
  style.textContent =
    `::highlight(${name}) { background-color: ${SEARCH_COLOR}; } ` +
    `::highlight(${currentName}) { background-color: ${SEARCH_CURRENT_COLOR}; }`;
  document.head.appendChild(style);

  let query = "";
  let index = 0;
  let frame = 0;

  /** Ranges of every match, found in the text of all nodes joined so matches cross markup. */
  const locate = (): DomRange[] => {
    if (!query) return [];
    const nodes: DomText[] = [];
    const starts: number[] = [];
    let joined = "";
    const walker = document.createTreeWalker(root, SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      starts.push(joined.length);
      nodes.push(node);
      joined += node.textContent ?? "";
    }
    // The last node starting at or before `offset` (before it, for an end offset).
    const point = (offset: number, end: boolean) => {
      let low = 0;
      let high = nodes.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (end ? starts[mid] < offset : starts[mid] <= offset) low = mid;
        else high = mid - 1;
      }
      return { node: nodes[low], offset: offset - starts[low] };
    };
    return findMatches(joined, query).map(({ from, to }) => {
      const start = point(from, false);
      const end = point(to, true);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    });
  };

  const paint = (reveal: boolean) => {
    frame = 0;
    const ranges = locate();
    const current = ranges.length === 0 ? -1 : Math.min(index, ranges.length - 1);
    const others = ranges.filter((_, i) => i !== current);
    if (others.length > 0) registry.set(name, new Highlight(...others));
    else registry.delete(name);
    if (current >= 0) {
      const highlight = new Highlight(ranges[current]);
      highlight.priority = 1;
      registry.set(currentName, highlight);
      if (reveal) {
        const element = (ranges[current].startContainer as DomText).parentElement;
        element?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } else {
      registry.delete(currentName);
    }
    onCount(ranges.length);
  };

  // The renderer may update the DOM after React commits; search again whenever it changes.
  const observer = new MutationObserver(() => {
    if (query && !frame) frame = requestAnimationFrame(() => paint(false));
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });

  return {
    update(nextQuery, nextIndex) {
      query = nextQuery;
      index = nextIndex;
      if (frame) cancelAnimationFrame(frame);
      paint(true);
    },
    dispose() {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      registry.delete(name);
      registry.delete(currentName);
      style.remove();
    },
  };
}

/**
 * Calls `onFind` on Ctrl+F (⌘F on macOS) while `node` is the panel in use: the last pointer press
 * landed inside it, or, before any press, it is visible. The browser's own find is suppressed
 * then. Returns the cleanup.
 */
export function watchFindShortcut(node: unknown, onFind: () => void): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const root = node as DomElement;
  let pressedInside: boolean | null = null;
  const visible = () => {
    const rect = root.getBoundingClientRect();
    return rect.right > rect.left && rect.bottom > rect.top;
  };
  const press: DomListener = (event) => {
    pressedInside = root.contains(event.target);
  };
  const key: DomListener = (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key?.toLowerCase() !== "f") return;
    if (!visible() || !(pressedInside ?? true)) return;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    onFind();
  };
  document.addEventListener("pointerdown", press, true);
  window.addEventListener("keydown", key, true);
  return () => {
    document.removeEventListener("pointerdown", press, true);
    window.removeEventListener("keydown", key, true);
  };
}

interface LocatedMark {
  /** The highlighted text, which is painted. */
  range: DomRange;
  /** The text plus its superscript reference: one hover target for the footnote. */
  hoverRange: DomRange;
  number: number | null;
}

/** The node and offset just past the superscript reference that follows `offset` in `nodes[index]`. */
function pastReference(nodes: DomText[], index: number, offset: number): { node: DomText; offset: number } {
  let end = { node: nodes[index], offset };
  for (let i = index; i < nodes.length; i++) {
    const text = nodes[i].textContent ?? "";
    let pos = i === index ? offset : 0;
    while (pos < text.length && (SUPERSCRIPT_DIGIT.test(text[pos]) || text[pos] === ",")) pos++;
    if (pos > (i === index ? offset : 0)) end = { node: nodes[i], offset: pos };
    // Stop at the first character that is not part of the reference.
    if (pos < text.length) break;
  }
  return end;
}

interface DomPoint {
  node: DomText;
  offset: number;
  /** Index of `node` among the container's text nodes. */
  index: number;
}

/** A mark from `start` to `end`; its reference, if any, begins at `after`. */
function located(
  nodes: DomText[],
  start: DomPoint,
  end: DomPoint,
  after: DomPoint,
  number: number | null,
): LocatedMark {
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const hoverRange = document.createRange();
  hoverRange.setStart(start.node, start.offset);
  const hoverEnd = number === null ? end : pastReference(nodes, after.index, after.offset);
  hoverRange.setEnd(hoverEnd.node, hoverEnd.offset);
  return { range, hoverRange, number };
}

/**
 * Finds each mark in the rendered DOM. The preview wraps marks in invisible sentinels, so each
 * one is found exactly where it is. If the renderer dropped the sentinels, falls back to a text
 * search that prefers the occurrence followed by the mark's own footnote number.
 */
function locateMarks(root: DomElement, marks: readonly Mark[]): LocatedMark[] {
  if (marks.length === 0) return [];
  const nodes: DomText[] = [];
  const opens: DomPoint[] = [];
  const closes: DomPoint[] = [];
  let plain = "";
  const at: DomPoint[] = [];
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = nodes.push(node) - 1;
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === MARK_OPEN) opens.push({ node, offset: i + 1, index });
      else if (text[i] === MARK_CLOSE) closes.push({ node, offset: i, index });
      if (!isKept(text[i])) continue;
      plain += text[i];
      at.push({ node, offset: i, index });
    }
  }

  if (opens.length === marks.length && closes.length === marks.length) {
    // The reference follows the close sentinel.
    return marks.map((mark, k) =>
      located(nodes, opens[k], closes[k], { ...closes[k], offset: closes[k].offset + 1 }, mark.number),
    );
  }

  const found: LocatedMark[] = [];
  let cursor = 0;
  for (const mark of marks) {
    const needle = [...mark.text].filter(isKept).join("");
    if (needle === "") continue;
    let chosen = -1;
    for (let index = plain.indexOf(needle, cursor); index !== -1; index = plain.indexOf(needle, index + 1)) {
      if (chosen === -1) chosen = index;
      if (mark.number === null) break;
      const last = at[index + needle.length - 1];
      const next = (last.node.textContent ?? "").slice(last.offset + 1, last.offset + 8);
      if (next.startsWith(superscript(mark.number))) {
        chosen = index;
        break;
      }
    }
    if (chosen === -1) continue;
    const last = at[chosen + needle.length - 1];
    const end = { ...last, offset: last.offset + 1 };
    found.push(located(nodes, at[chosen], end, end, mark.number));
    cursor = chosen + needle.length;
  }
  return found;
}

/** Text selected in rendered Markdown, with where to float the ask button. */
export interface RenderedSelection {
  text: string;
  /** Rendered text before the selection; `keptLength` turns it into a source-search hint. */
  prefix: string;
  /** Button position relative to the container's top-left corner. */
  top: number;
  left: number;
  /** A copy of the selected DOM range, for `holdHighlight` once focus leaves the text. */
  range: unknown;
}

const HELD_NAME = "doc-ask-held-selection";
const HELD_COLOR = "rgba(80, 140, 255, 0.35)";
let heldStyle: { remove(): void } | null = null;

/**
 * Keeps showing `range` as selected after the page selection moves elsewhere, such as into a
 * text field. Returns the cleanup.
 */
export function holdHighlight(range: unknown): () => void {
  const globals = globalThis as HighlightGlobals;
  const registry = globals.CSS?.highlights;
  if (Platform.OS !== "web" || !range || !registry || !globals.Highlight) return () => {};
  if (!heldStyle) {
    const style = document.createElement("style");
    style.textContent = `::highlight(${HELD_NAME}) { background-color: ${HELD_COLOR}; }`;
    document.head.appendChild(style);
    heldStyle = style;
  }
  registry.set(HELD_NAME, new globals.Highlight(range as DomRange));
  return () => registry.delete(HELD_NAME);
}

/** Approximate width of the floating action buttons, to keep them inside the container. */
const ACTIONS_WIDTH = 120;

interface SelectionWatcher {
  root: DomElement;
  onChange: (selection: RenderedSelection | null) => void;
  /**
   * The selection last reported; an unchanged selection keeps its button position, so pressing
   * a button (which also fires mouseup) never moves the buttons out from under the pointer.
   */
  lastKey: string | null;
}

/** Every container watched for selections. One set of document listeners serves them all. */
const selectionWatchers = new Set<SelectionWatcher>();

function currentSelectionRange(): DomRange | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  return selection.getRangeAt(0);
}

function selectionOwner(range: DomRange | null): SelectionWatcher | undefined {
  if (!range) return undefined;
  for (const watcher of selectionWatchers) {
    if (watcher.root.contains(range.commonAncestorContainer)) return watcher;
  }
  return undefined;
}

function reportSelection(watcher: SelectionWatcher, selection: RenderedSelection | null): void {
  watcher.lastKey = selection ? `${selection.prefix.length}:${selection.text}` : null;
  watcher.onChange(selection);
}

/** After the mouse or a key is released: report to the container holding the selection. */
const settleSelection: DomListener = (event) => {
  const range = currentSelectionRange();
  const owner = selectionOwner(range);
  for (const watcher of selectionWatchers) if (watcher !== owner) reportSelection(watcher, null);
  if (!owner || !range) return;
  const root = owner.root;
  // Drop the invisible highlight sentinels the preview adds.
  const text = range.toString().split(MARK_OPEN).join("").split(MARK_CLOSE).join("");
  if (text.trim() === "") return reportSelection(owner, null);
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const prefix = before.toString();
  if (`${prefix.length}:${text}` === owner.lastKey) return;
  const box = root.getBoundingClientRect();
  let x: number;
  let y: number;
  if (event.type === "mouseup") {
    // Where the drag ended.
    x = event.clientX;
    y = event.clientY + 12;
  } else {
    // Keyboard selection: the end of the selected text.
    const rects = range.getClientRects();
    const end = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    x = end.right;
    y = end.bottom + 6;
  }
  const maxLeft = Math.max(0, box.right - box.left - ACTIONS_WIDTH);
  reportSelection(owner, {
    text,
    prefix,
    top: y - box.top,
    left: Math.min(maxLeft, Math.max(0, x - box.left - 8)),
    range: range.cloneRange(),
  });
};

/** While the selection changes: tell only containers with an open selection that it left. */
const collapseSelection = () => {
  const owner = selectionOwner(currentSelectionRange());
  for (const watcher of selectionWatchers) {
    if (watcher !== owner && watcher.lastKey !== null) reportSelection(watcher, null);
  }
};

/**
 * Reports selections inside `container` after the mouse or keyboard settles, and null when the
 * selection collapses or leaves it. A mouse selection places the buttons where the drag ended.
 * Returns the unsubscribe function.
 */
export function watchSelection(
  container: unknown,
  onChange: (selection: RenderedSelection | null) => void,
): () => void {
  if (Platform.OS !== "web" || !container) return () => {};
  const watcher: SelectionWatcher = { root: container as DomElement, onChange, lastKey: null };
  if (selectionWatchers.size === 0) {
    document.addEventListener("mouseup", settleSelection);
    document.addEventListener("keyup", settleSelection);
    document.addEventListener("selectionchange", collapseSelection);
  }
  selectionWatchers.add(watcher);
  return () => {
    selectionWatchers.delete(watcher);
    if (selectionWatchers.size === 0) {
      document.removeEventListener("mouseup", settleSelection);
      document.removeEventListener("keyup", settleSelection);
      document.removeEventListener("selectionchange", collapseSelection);
    }
  };
}

/** Stops presses on `node` from clearing the page selection. Returns the cleanup. */
export function keepSelectionOnPress(node: unknown): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const element = node as DomElement;
  const prevent: DomListener = (event) => event.preventDefault();
  element.addEventListener("mousedown", prevent);
  return () => element.removeEventListener("mousedown", prevent);
}

export interface DocViewerHandle {
  /** Replaces the shown text, touching only the changed range so the scroll position holds. */
  setText(text: string): void;
  /** Highlights every match of `query`, marks match `index` as current, and scrolls to it. */
  search(query: string, index: number): void;
  destroy(): void;
}

export type AskHandler = (range: TextRange, selected: string, mode: AskMode) => void;

/** Labels of the actions offered over a selection, in display order. */
export const ASK_ACTIONS: readonly { mode: AskMode; label: string }[] = [
  { mode: "term", label: "설명" },
  { mode: "question", label: "질문" },
];

/**
 * Read-only Markdown source view; a button appears over every non-empty selection. `onSearchCount`
 * hears the number of search matches after every search and every text change.
 */
export function mountViewer(
  parent: unknown,
  text: string,
  theme: PluginFilePanelProps["theme"],
  onAsk: AskHandler,
  onSearchCount: (count: number) => void,
): DocViewerHandle | null {
  if (Platform.OS !== "web" || !parent) return null;
  const { EditorState: State, StateEffect, StateField } =
    require("@codemirror/state") as typeof import("@codemirror/state");
  const { Decoration, EditorView: View, showTooltip } =
    require("@codemirror/view") as typeof import("@codemirror/view");
  const { markdown } =
    require("@codemirror/lang-markdown") as typeof import("@codemirror/lang-markdown");
  const { syntaxHighlighting, defaultHighlightStyle } =
    require("@codemirror/language") as typeof import("@codemirror/language");

  function askTooltips(state: EditorState): readonly Tooltip[] {
    const main = state.selection.main;
    if (main.empty) return [];
    const range = { from: main.from, to: main.to };
    const selected = state.sliceDoc(main.from, main.to);
    if (selected.trim() === "") return [];
    return [
      {
        pos: main.head,
        above: main.head <= main.anchor,
        strictSide: true,
        arrow: false,
        create() {
          const bar = document.createElement("div");
          bar.className = "cm-doc-ask-actions";
          for (const action of ASK_ACTIONS) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "cm-doc-ask-button";
            button.textContent = action.label;
            // Keep the editor selection when the button is pressed.
            button.addEventListener("mousedown", (event) => event.preventDefault());
            button.addEventListener("click", () => onAsk(range, selected, action.mode));
            bar.appendChild(button);
          }
          return { dom: bar as never };
        },
      },
    ];
  }

  const askField = StateField.define<readonly Tooltip[]>({
    create: askTooltips,
    update: (value, tr: Transaction) =>
      tr.docChanged || tr.selection ? askTooltips(tr.state) : value,
    provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
  });

  interface SearchState {
    query: string;
    index: number;
    matches: TextRange[];
  }
  const setSearch = StateEffect.define<SearchState>();
  const matchMark = Decoration.mark({ class: "cm-doc-ask-match" });
  const currentMark = Decoration.mark({ class: "cm-doc-ask-match-current" });
  const searchField = StateField.define<SearchState>({
    create: () => ({ query: "", index: 0, matches: [] }),
    update(value, tr: Transaction) {
      for (const effect of tr.effects) if (effect.is(setSearch)) return effect.value;
      if (!tr.docChanged || !value.query) return value;
      return { ...value, matches: findMatches(tr.state.doc.toString(), value.query) };
    },
    provide: (field) =>
      View.decorations.from(field, ({ index, matches }) => {
        const current = Math.min(index, matches.length - 1);
        return Decoration.set(
          matches.map((match, i) => (i === current ? currentMark : matchMark).range(match.from, match.to)),
        );
      }),
  });

  const view: EditorView = new View({
    parent: parent as EditorViewConfig["parent"],
    state: State.create({
      doc: text,
      extensions: [
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        State.readOnly.of(true),
        View.lineWrapping,
        askField,
        searchField,
        View.updateListener.of((update) => {
          if (update.docChanged && update.state.field(searchField).query) {
            onSearchCount(update.state.field(searchField).matches.length);
          }
        }),
        View.contentAttributes.of({ "aria-label": "문서 (읽기 전용)" }),
        View.theme({
          "&": {
            height: "100%",
            color: theme.colors.foreground,
            backgroundColor: theme.colors.surface0,
          },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { padding: "16px", caretColor: theme.colors.foreground },
          ".cm-tooltip.cm-doc-ask-actions": {
            display: "flex",
            gap: "6px",
            backgroundColor: "transparent",
            border: "none",
          },
          ".cm-doc-ask-match": { backgroundColor: SEARCH_COLOR },
          ".cm-doc-ask-match-current": { backgroundColor: SEARCH_CURRENT_COLOR },
          ".cm-doc-ask-button": {
            backgroundColor: theme.colors.accent,
            color: theme.colors.accentForeground,
            border: "none",
            borderRadius: "6px",
            padding: "4px 10px",
            cursor: "pointer",
            font: "inherit",
          },
        }),
      ],
    }),
  });

  return {
    setText(next) {
      const current = view.state.doc.toString();
      if (current === next) return;
      let start = 0;
      const max = Math.min(current.length, next.length);
      while (start < max && current[start] === next[start]) start++;
      let end = 0;
      while (
        end < max - start &&
        current[current.length - 1 - end] === next[next.length - 1 - end]
      ) {
        end++;
      }
      view.dispatch({
        changes: {
          from: start,
          to: current.length - end,
          insert: next.slice(start, next.length - end),
        },
      });
    },
    search(query, index) {
      const matches = findMatches(view.state.doc.toString(), query);
      const current = matches[Math.min(index, matches.length - 1)];
      view.dispatch({
        effects: [
          setSearch.of({ query, index, matches }),
          ...(current ? [View.scrollIntoView(current.from, { y: "center" })] : []),
        ],
      });
      onSearchCount(matches.length);
    },
    destroy() {
      view.destroy();
    },
  };
}

/**
 * Calls `handler` on every click inside `node` before the clicked element handles it, so a
 * link's own navigation still runs afterwards. Returns the cleanup.
 */
export function onClickCapture(node: unknown, handler: () => void): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const element = node as DomElement;
  const listener: DomListener = () => handler();
  element.addEventListener("click", listener, true);
  return () => element.removeEventListener("click", listener, true);
}

/**
 * Takes Enter for a dialog: calls `handler` before any focused control sees the key, so Enter
 * confirms instead of pressing whatever button holds focus. Returns the cleanup.
 */
export function onEnterKey(handler: () => void): () => void {
  if (Platform.OS !== "web") return () => {};
  const listener: DomListener = (event) => {
    if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation?.();
    handler();
  };
  document.addEventListener("keydown", listener, true);
  return () => document.removeEventListener("keydown", listener, true);
}

/** The rendered size of `node`, measured on demand instead of on every layout. */
export function elementSize(node: unknown): { width: number; height: number } {
  if (Platform.OS !== "web" || !node) return { width: 0, height: 0 };
  const box = (node as DomElement).getBoundingClientRect();
  return { width: box.right - box.left, height: box.bottom - box.top };
}
