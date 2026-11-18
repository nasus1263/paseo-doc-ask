# paseo-doc-ask

[한국어](README.ko.md)

A [Paseo](https://paseo.sh) plugin for reading Markdown with an AI at your side. Select text in a document or an agent reply, ask for an explanation or a visual, and keep the answer as a footnote.

## Install

```bash
paseo plugin add git:nasus1263/paseo-doc-ask
```

Plugins must be enabled on the daemon (**Settings → Plugins → Enable plugins**). Requires Paseo `>=0.16.0-beta.2` and npm on the daemon's `PATH`.

## Usage

- Open a `.md` file and pick the **문서 질문** panel.
- Select text in Preview. An input box opens.
  - **Enter**: ask (empty input = explain)
  - **Ctrl+Enter**: save your own note, no AI
  - Buttons: explain, visualize, ask, note
  - Closing the box with text in it, without sending, keeps it as a **draft note** (blue passage; click to continue, delete with the trash button or by clearing the text). It never reaches the AI or the document.
- Answers are saved as a highlight (`==text==[^n]`) in the document, and the footnote body goes to `<name>.comment.md` next to it.
- The side **주석** panel lists footnotes. You can ask follow-ups, bookmark, add memos, or delete.
- Agent replies: turn on **대화 주석 켜기** in the Command Center (Ctrl/⌘K). Notes on replies can be attached to your next message automatically.

See [OVERVIEW.md](OVERVIEW.md) for full details.

## Notes

- **Edits your files**: it adds highlights and footnote refs to the document and creates `*.comment.md` files.
- **Sends data to Claude**: the document path and content, the selection, your question, and your custom prompt go to Paseo's Claude provider. It runs hidden helper agents, up to 4 per workspace.
- Read tools are auto-approved. Other tool requests need your approval in the app and are denied after 5 minutes.
- Selection and tooltips work on desktop and web only.
- Reply annotations and note injection depend on Paseo's internal UI markup, so a Paseo update can break them. They are off by default.
