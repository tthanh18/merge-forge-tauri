import Module from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

/**
 * Smoke-tests the *bundled* extension host against a stub `vscode`.
 *
 * The other suites import source modules directly, so nothing else would notice a bundle
 * that fails at load — a bad import or a missing export shows up only as "extension failed
 * to activate" once it is installed. This catches that without an editor.
 */

const bundlePath = fileURLToPath(new URL('../dist/extension.js', import.meta.url));

interface Recorded {
  commands: string[];
  subscriptions: number;
  disposables: number;
}

/** Minimal stand-in for the parts of the API activate() touches. */
function makeVscodeStub(recorded: Recorded): Record<string, unknown> {
  const disposable = () => {
    recorded.disposables++;
    return { dispose: () => {} };
  };
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
      joinPath: (base: unknown, ...parts: string[]) => ({ fsPath: parts.join('/'), base }),
    },
    EventEmitter: class {
      event = () => disposable();
      fire() {}
    },
    Range: class {
      constructor(...args: number[]) {
        void args;
      }
    },
    CodeLens: class {
      constructor(...args: unknown[]) {
        void args;
      }
    },
    ViewColumn: { Active: -1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    commands: {
      registerCommand: (id: string) => {
        recorded.commands.push(id);
        return disposable();
      },
      executeCommand: async () => undefined,
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: undefined,
        backgroundColor: undefined,
        show: () => {},
        hide: () => {},
        dispose: () => {},
      }),
      createWebviewPanel: () => {
        throw new Error('not expected during activation');
      },
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showQuickPick: async () => undefined,
      onDidChangeActiveTextEditor: () => disposable(),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      createFileSystemWatcher: () => ({
        onDidChange: () => disposable(),
        onDidCreate: () => disposable(),
        onDidDelete: () => disposable(),
        dispose: () => {},
      }),
      onDidChangeWorkspaceFolders: () => disposable(),
      openTextDocument: async () => ({ languageId: 'plaintext' }),
    },
    languages: { registerCodeLensProvider: () => disposable() },
  };
}

/** Loads the CJS bundle with `vscode` resolved to the stub. */
function loadBundle(stub: unknown): {
  activate: (context: unknown) => void;
  deactivate: () => void;
} {
  const require = Module.createRequire(import.meta.url);
  const original = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
  (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = (...args: unknown[]) =>
    args[0] === 'vscode' ? stub : original(...args);
  try {
    delete require.cache[require.resolve(bundlePath)];
    return require(bundlePath);
  } finally {
    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = original;
  }
}

describe('the bundled extension', () => {
  beforeAll(() => {
    if (!existsSync(bundlePath)) {
      throw new Error(`run "pnpm run build" first: ${bundlePath} is missing`);
    }
  });

  test('activates without throwing and registers its commands', () => {
    const recorded: Recorded = { commands: [], subscriptions: 0, disposables: 0 };
    const bundle = loadBundle(makeVscodeStub(recorded));
    const context = { subscriptions: [] as unknown[], extensionUri: { fsPath: '/ext' } };

    expect(() => bundle.activate(context)).not.toThrow();

    // Read the manifest rather than hardcoding: a command contributed in package.json but
    // never registered shows up as "command not found" the first time someone clicks it.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { contributes: { commands: Array<{ command: string }> } };
    const contributed = manifest.contributes.commands.map((c) => c.command).sort();
    expect(recorded.commands.sort()).toEqual(contributed);

    // Registrations must be disposed on deactivate, so they go through subscriptions.
    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  test('deactivates without throwing', () => {
    const recorded: Recorded = { commands: [], subscriptions: 0, disposables: 0 };
    const bundle = loadBundle(makeVscodeStub(recorded));
    bundle.activate({ subscriptions: [], extensionUri: { fsPath: '/ext' } });
    expect(() => bundle.deactivate()).not.toThrow();
  });
});
