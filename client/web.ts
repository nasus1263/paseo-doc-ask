import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import type { EditorState, Transaction } from "@codemirror/state";
import type { EditorView, EditorViewConfig, Tooltip } from "@codemirror/view";
import { Platform } from "react-native";
import type { TextRange } from "../shared/markdown";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface DomButton {
  className: string;
  textContent: string | null;
  type: string;
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
}
declare const document: { createElement(tag: "button"): DomButton };

export interface DocViewerHandle {
  /** Replaces the shown text, touching only the changed range so the scroll position holds. */
  setText(text: string): void;
  destroy(): void;
}

export type AskHandler = (range: TextRange, selected: string) => void;

const ASK_LABEL = "AI에게 묻기";

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
          const button = document.createElement("button");
          button.type = "button";
          button.className = "cm-doc-ask-button";
          button.textContent = ASK_LABEL;
          // Keep the editor selection when the button is pressed.
          button.addEventListener("mousedown", (event) => event.preventDefault());
          button.addEventListener("click", () => onAsk(range, selected));
          return { dom: button as never };
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
          ".cm-tooltip.cm-doc-ask-button": {
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
