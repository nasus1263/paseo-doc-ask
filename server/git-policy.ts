/**
 * Which shell commands the explainer may run while committing footnotes: single git commands
 * that read the repository, stage through `git apply --cached`, or commit what is staged. No
 * command chaining, redirection, `git add`, or commits that bypass the index or hooks.
 */

const READ_ONLY = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]);
/** `git commit` options that take a separate value argument. */
const COMMIT_VALUE_OPTIONS = new Set(["-m", "--message", "-F", "--file", "--author", "--date", "--cleanup"]);
const COMMIT_FORBIDDEN = /^(-a|--all|--amend|--no-verify|-n|-o|--only|-i|--include|-C|-c|--reuse-message|--reedit-message|--fixup|--squash)$/;

/** Splits a shell command line into words, honoring single and double quotes. Null if unbalanced. */
export function shellWords(line: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

/** Whether the explainer may run `command` while committing footnotes. */
export function isAllowedGitCommand(command: string): boolean {
  const lines = command.trim().split("\n");
  let first = lines[0].trim();
  // A heredoc may feed stdin (a patch or a commit message); its body is data, not shell.
  const heredoc = /\s<<-?\s*(['"]?)(\w+)\1\s*$/.exec(first);
  if (heredoc) {
    if (lines.length < 2 || lines[lines.length - 1].trim() !== heredoc[2]) return false;
    first = first.slice(0, heredoc.index);
  } else if (lines.length > 1) {
    return false;
  }
  if (/[;&|`<>]|\$\(/.test(first)) return false;
  const words = shellWords(first);
  if (!words || words[0] !== "git") return false;
  let i = 1;
  if (words[i] === "-C") {
    if (!words[i + 1]) return false;
    i += 2;
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  if (READ_ONLY.has(sub)) return !args.some((arg) => arg === "--output" || arg.startsWith("--output="));
  if (sub === "apply") return args.includes("--cached") && !args.includes("--index");
  if (sub === "commit") return commitArgsAllowed(args);
  return false;
}

/** A commit that only records the index: no pathspecs, `-a`, amend, or hook bypass. */
function commitArgsAllowed(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (COMMIT_VALUE_OPTIONS.has(arg)) {
      i++;
      continue;
    }
    if (/^(--message|--file|--author|--date|--cleanup)=/.test(arg) || /^-[mF]./.test(arg)) continue;
    if (COMMIT_FORBIDDEN.test(arg)) return false;
    // Combined short flags such as -am.
    if (/^-[a-zA-Z]{2,}$/.test(arg)) return false;
    if (arg === "--" || !arg.startsWith("-")) return false;
  }
  return true;
}
