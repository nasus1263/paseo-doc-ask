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

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface DomEvent {
  type: string;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}
type DomListener = (event: DomEvent) => void;
interface DomEvents {
  addEventListener(type: string, listener: DomListener): void;
  removeEventListener(type: string, listener: DomListener): void;
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
  Highlight?: new (...ranges: DomRange[]) => unknown;
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
  dispose(): void;
}

let decorationCount = 0;

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
  const none: PreviewDecorations = { setMarks() {}, dispose() {} };
  if (Platform.OS !== "web" || !container || !overlay) return none;
  const root = container as DomElement;
  const overlayElement = overlay as DomElement;
  const globals = globalThis as HighlightGlobals;
  const registry = globals.CSS?.highlights;
  const name = `doc-ask-mark-${++decorationCount}`;
  const style = document.createElement("style");
  style.textContent = `::highlight(${name}) { background-color: ${MARK_COLOR}; }`;
  document.head.appendChild(style);

  let marks: readonly Mark[] = [];
  let painted: LocatedMark[] = [];
  let frame = 0;

  const paint = () => {
    frame = 0;
    painted = locateMarks(root, marks);
    if (!registry || !globals.Highlight) return;
    if (painted.length === 0) registry.delete(name);
    else registry.set(name, new globals.Highlight(...painted.map((mark) => mark.range)));
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  // The renderer may update the DOM after React commits; repaint whenever it changes.
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true, characterData: true });

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
  const footnoteAt = (x: number, y: number): { number: number; rect: DomRect } | null => {
    for (const mark of painted) {
      if (mark.number === null) continue;
      const rects = mark.hoverRange.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        if (within(rects[i], x, y)) return { number: mark.number, rect: rects[i] };
      }
    }
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
      marks = next;
      schedule();
    },
    dispose() {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener("mousemove", move);
      root.removeEventListener("mouseleave", leave);
      root.removeEventListener("click", click);
      registry?.delete(name);
      style.remove();
    },
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
}

/** Approximate width of the floating action buttons, to keep them inside the container. */
const ACTIONS_WIDTH = 120;

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
  const root = container as DomElement;
  const current = (): DomRange | null => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return root.contains(range.commonAncestorContainer) ? range : null;
  };
  // The selection last reported; an unchanged selection keeps its button position, so pressing
  // a button (which also fires mouseup) never moves the buttons out from under the pointer.
  let lastKey: string | null = null;
  const report = (selection: RenderedSelection | null) => {
    lastKey = selection ? `${selection.prefix.length}:${selection.text}` : null;
    onChange(selection);
  };
  const settle: DomListener = (event) => {
    const range = current();
    // Drop the invisible highlight sentinels the preview adds.
    const text = (range?.toString() ?? "").split(MARK_OPEN).join("").split(MARK_CLOSE).join("");
    if (!range || text.trim() === "") return report(null);
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const prefix = before.toString();
    if (`${prefix.length}:${text}` === lastKey) return;
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
    report({
      text,
      prefix,
      top: y - box.top,
      left: Math.min(maxLeft, Math.max(0, x - box.left - 8)),
    });
  };
  const collapse = () => {
    if (!current()) report(null);
  };
  document.addEventListener("mouseup", settle);
  document.addEventListener("keyup", settle);
  document.addEventListener("selectionchange", collapse);
  return () => {
    document.removeEventListener("mouseup", settle);
    document.removeEventListener("keyup", settle);
    document.removeEventListener("selectionchange", collapse);
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
  destroy(): void;
}

export type AskHandler = (range: TextRange, selected: string, mode: AskMode) => void;

/** Labels of the actions offered over a selection, in display order. */
export const ASK_ACTIONS: readonly { mode: AskMode; label: string }[] = [
  { mode: "term", label: "설명" },
  { mode: "question", label: "질문" },
];

/** Read-only Markdown source view; a button appears over every non-empty selection. */
export function mountViewer(
  parent: unknown,
  text: string,
  theme: PluginFilePanelProps["theme"],
  onAsk: AskHandler,
): DocViewerHandle | null {
  if (Platform.OS !== "web" || !parent) return null;
  const { EditorState: State, StateField } =
    require("@codemirror/state") as typeof import("@codemirror/state");
  const { EditorView: View, showTooltip } =
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
    destroy() {
      view.destroy();
    },
  };
}

/** Reports vertical mouse drags that start on `handle`. Returns the cleanup. */
export function watchVerticalDrag(
  handle: unknown,
  on: { start(): void; move(dy: number): void; end(): void },
): () => void {
  if (Platform.OS !== "web" || !handle) return () => {};
  const element = handle as DomElement;
  let startY: number | null = null;
  const move: DomListener = (event) => {
    if (startY !== null) on.move(event.clientY - startY);
  };
  const stop = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
  };
  const up: DomListener = () => {
    if (startY === null) return;
    startY = null;
    stop();
    on.end();
  };
  const down: DomListener = (event) => {
    // Keep the drag from selecting text.
    event.preventDefault();
    startY = event.clientY;
    on.start();
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  element.addEventListener("mousedown", down);
  return () => {
    element.removeEventListener("mousedown", down);
    stop();
  };
}
