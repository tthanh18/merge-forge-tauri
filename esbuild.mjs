import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const webviewOnly = process.argv.includes('--webview-only');

if (production) {
  rmSync(new URL('./dist/', import.meta.url), { recursive: true, force: true });
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

/** Extension host bundle (Node/CJS — VS Code loads the entry as CommonJS). */
const extensionOptions = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

/** Webview app bundle (browser/IIFE, Monaco included). */
const webviewOptions = {
  ...common,
  entryPoints: ['webview/main.ts'],
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  loader: {
    '.ttf': 'file',
    '.css': 'css',
  },
};

/** Monaco's core editor worker, bundled separately (loaded via blob trampoline). */
const workerOptions = {
  ...common,
  entryPoints: { 'editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

/** The Conflicts dialog — a deliberately tiny bundle with no Monaco in it. */
const conflictsOptions = {
  ...common,
  entryPoints: { conflicts: 'webview-conflicts/main.ts' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  // The dialog imports Monaco's codicon.css for the icon font (font only — the
  // per-icon content rules it needs are its own, in styles.css).
  loader: {
    '.ttf': 'file',
    '.css': 'css',
  },
};

const allOptions = webviewOnly
  ? [webviewOptions, workerOptions]
  : [extensionOptions, webviewOptions, workerOptions, conflictsOptions];

if (watch) {
  const contexts = await Promise.all(allOptions.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(allOptions.map((options) => esbuild.build(options)));
}
