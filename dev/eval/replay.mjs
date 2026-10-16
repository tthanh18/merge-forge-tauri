/**
 * Launcher for the merge-replay eval: bundles main.ts on the fly (so the eval can
 * import the extension's real TS pipeline) and runs it with the given arguments.
 *
 *   pnpm run eval -- --repo ../some-repo --merges 10
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mf-eval-build-'));
const outfile = join(outDir, 'main.mjs');

try {
  await build({
    entryPoints: [join(here, 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    // node built-ins resolve at runtime; nothing here may import 'vscode'.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const { main } = await import(pathToFileURL(outfile).href);
  await main();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
