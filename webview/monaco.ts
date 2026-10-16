import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
// Monarch grammars for every built-in language. Deliberately *not* importing
// editor.main or the language services (ts/html/css/json workers): syntax
// highlighting is all a merge tool needs, and this keeps the bundle a few MB smaller.
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution';
// The find widget (Cmd/Ctrl+F): editor.api alone ships no contrib features, and
// searching within big conflicted files is table stakes for a merge editor.
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';
// The codicon @font-face and per-icon glyph rules — our toolbar and chunk controls use
// the same icon font as VS Code. Without this import the font never reaches the bundle
// and every icon renders as tofu (found the hard way).
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js';

export { monaco };

declare global {
  interface Window {
    __mergeForge: { workerUri: string };
    MonacoEnvironment?: monaco.Environment;
  }
}

/**
 * Points Monaco at its worker.
 *
 * A webview runs on a `vscode-webview://` origin, so `new Worker(<https resource uri>)`
 * is cross-origin and blocked. Fetching the worker's source and constructing it from a
 * same-origin blob URL is the way around that — hence `worker-src blob:` in the CSP.
 *
 * If that fails we fall back to a worker-less stub: Monaco degrades to losing link
 * detection and word-based suggestions, which a merge tool can live without. Failing to
 * open the merge editor over it would be far worse.
 */
export async function configureMonacoWorker(onWarning: (message: string) => void): Promise<void> {
  try {
    const response = await fetch(window.__mergeForge.workerUri);
    if (!response.ok) {
      throw new Error(`worker fetch returned ${response.status}`);
    }
    const source = await response.text();
    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    window.MonacoEnvironment = { getWorker: () => new Worker(blobUrl) };
  } catch (error) {
    onWarning(
      `Monaco worker unavailable, continuing without it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    window.MonacoEnvironment = {
      getWorker: () => new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' }))),
    };
  }
}
