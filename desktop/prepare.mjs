import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = dirname(fileURLToPath(import.meta.url));
const root = resolve(desktop, '..');
const out = resolve(desktop, 'ui-dist');
const production = process.argv.includes('--production');

const build = spawnSync(
  process.execPath,
  ['esbuild.mjs', '--webview-only', ...(production ? ['--production'] : [])],
  { cwd: root, stdio: 'inherit' },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(resolve(root, 'dist/webview'), out, { recursive: true });
cpSync(resolve(desktop, 'shell/index.html'), resolve(out, 'index.html'));
