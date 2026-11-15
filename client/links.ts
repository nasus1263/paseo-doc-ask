import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import {
  directoryOf,
  distinctPaths,
  extractLinkTokens,
  type Resolution,
  resolveLinksRpc,
  rewriteLinks,
} from "../shared/links";

/**
 * `text` with its file links pointed at the files they mean. Paseo resolves a link in this panel
 * against the workspace root, while documents usually link relative to their own folder; the
 * daemon tries the document's folder, the workspace root, and then a search by file name. Until
 * it answers, the text is returned as written.
 */
export function useLinkedMarkdown(text: string | null, documentPath: string, root: string | null): string | null {
  const base = directoryOf(documentPath);
  const workspaceRoot = root || base;
  return useResolvedMarkdown(text, [base, workspaceRoot], workspaceRoot);
}

/**
 * `text` with its file links pointed at the files they mean: as written relative to each of
 * `bases`, then under the workspace `root`, then by file name in it. Until the daemon answers,
 * or without a root, the text is returned as written.
 */
export function useResolvedMarkdown(text: string | null, bases: string[], root: string): string | null {
  const resolve = useRpc(resolveLinksRpc);
  const tokens = useMemo(() => (text === null ? [] : extractLinkTokens(text)), [text]);
  const paths = useMemo(() => distinctPaths(tokens), [tokens]);
  const key = root && paths.length > 0 ? JSON.stringify([bases, root, paths]) : null;
  const [resolved, setResolved] = useState<{ key: string; results: Resolution[] } | null>(null);

  useEffect(() => {
    if (!key) return;
    let live = true;
    resolve({ bases, root, paths }).then(
      ({ results }) => {
        if (live) setResolved({ key, results });
      },
      (cause: unknown) => console.warn("[doc-ask] resolving links failed", cause),
    );
    return () => {
      live = false;
    };
    // `key` covers bases, root, and paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolve]);

  return useMemo(() => {
    if (text === null || !resolved || resolved.key !== key) return text;
    const byPath = new Map(paths.map((path, index) => [path, resolved.results[index]!] as const));
    return rewriteLinks(text, tokens, byPath, root);
  }, [text, tokens, paths, resolved, key, root]);
}
