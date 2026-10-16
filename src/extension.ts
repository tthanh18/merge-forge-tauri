import * as vscode from 'vscode';
import { API_KEY_SECRET, secretKeyFor } from './ai/provider';
import { PROVIDERS, resolveModel, type ProviderSpec } from './ai/providers';
import { listConflicted } from './git/conflicts';
import { detectOperation } from './git/repoContext';
import { readStages } from './git/stages';
import { getOutputChannel } from './log';
import { ConflictsPanel } from './panel/ConflictsPanel';
import { MergePanel } from './panel/MergePanel';
import { ConflictCodeLensProvider } from './ui/codeLens';
import { activeRepoRoot } from './ui/conflictPicker';
import { ContextKeys } from './ui/contextKeys';
import { confirmAndAbort, MergeStatusCluster } from './ui/mergeStatus';

export function activate(context: vscode.ExtensionContext): void {
  const cluster = new MergeStatusCluster(context);
  let conflictedPaths = new Set<string>();
  let knownRepoRoot: string | undefined;

  // ContextKeys owns the single .git/index watcher; the menus' context keys, the
  // CodeLens, the status cluster, and the Conflicts dialog all follow its refreshes.
  const contextKeys = new ContextKeys(context, (absolutePaths, repoRoot) => {
    const hadConflicts = conflictedPaths.size > 0;
    conflictedPaths = new Set(absolutePaths);
    knownRepoRoot = repoRoot;
    codeLens.refresh();
    void cluster.refresh(repoRoot, conflictedPaths.size);
    ConflictsPanel.refresh();
    // JetBrains pops its Conflicts dialog the moment a merge hits conflicts.
    if (!hadConflicts && conflictedPaths.size > 0 && repoRoot && readAutoShow()) {
      ConflictsPanel.show(context, repoRoot);
    }
  });
  contextKeys.register();

  const codeLens = new ConflictCodeLensProvider((uri) => conflictedPaths.has(uri.fsPath));

  const showConflicts = async (): Promise<void> => {
    const repoRoot = knownRepoRoot ?? (await activeRepoRoot());
    if (!repoRoot) {
      void vscode.window.showErrorMessage('Merge Forge: no git repository found.');
      return;
    }
    ConflictsPanel.show(context, repoRoot);
  };

  const open = async (uri?: vscode.Uri): Promise<void> => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showErrorMessage('Merge Forge: no file selected.');
      return;
    }
    await MergePanel.createOrShow(context, target);
    await contextKeys.refresh();
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    vscode.commands.registerCommand('mergeForge.showConflicts', showConflicts),
    // Both older entry points now lead to the dialog too — one flow, one list.
    vscode.commands.registerCommand('mergeForge.resolve', showConflicts),
    vscode.commands.registerCommand('mergeForge.pickConflicted', showConflicts),
    vscode.commands.registerCommand(
      'mergeForge.resolveThis',
      (arg?: vscode.Uri | { resourceUri?: vscode.Uri }) =>
        open(arg instanceof vscode.Uri ? arg : arg?.resourceUri),
    ),
    vscode.commands.registerCommand('mergeForge.abortMerge', async () => {
      const repoRoot = knownRepoRoot ?? (await activeRepoRoot());
      const operation = repoRoot ? await detectOperation(repoRoot) : undefined;
      if (!repoRoot || !operation || operation.kind === 'unknown') {
        void vscode.window.showInformationMessage(
          'Merge Forge: no merge, rebase, or cherry-pick is in progress.',
        );
        return;
      }
      if (await confirmAndAbort(repoRoot, operation)) {
        await contextKeys.refresh();
      }
    }),
    vscode.commands.registerCommand('mergeForge.nextChange', () =>
      MergePanel.runOnActive('nextChange'),
    ),
    vscode.commands.registerCommand('mergeForge.prevChange', () =>
      MergePanel.runOnActive('prevChange'),
    ),
    vscode.commands.registerCommand('mergeForge.applyAllNonConflicting', () =>
      MergePanel.runOnActive('applyAllNonConflicting'),
    ),
    vscode.commands.registerCommand('mergeForge.diagnostics', () => showDiagnostics(context)),
    vscode.commands.registerCommand('mergeForge.setApiKey', () => setUpAiProvider(context)),
    vscode.commands.registerCommand('mergeForge.clearApiKey', () => clearAiKeys(context)),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      // Opening a conflicted file can jump straight into the merge editor, for people
      // who would rather never see the markers.
      if (editor && readAutoOpen() && conflictedPaths.has(editor.document.uri.fsPath)) {
        await MergePanel.createOrShow(context, editor.document.uri);
      }
    }),
  );
}

/**
 * The guided AI setup: pick a provider, enter its key (and endpoint/model for
 * Custom), and make it the active `mergeForge.ai.provider` — one flow, no
 * settings spelunking. Keys live in SecretStorage, one per provider.
 */
async function setUpAiProvider(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('mergeForge');
  const current = config.get<string>('ai.provider', 'anthropic');
  const picked = await vscode.window.showQuickPick(
    PROVIDERS.map((spec) => ({
      label: spec.label,
      ...(spec.id === current ? { description: 'current' } : {}),
      detail: spec.defaultModel
        ? `Default model: ${spec.defaultModel}`
        : 'Your own OpenAI-compatible endpoint (OpenRouter, Ollama, proxies…)',
      spec,
    })),
    { title: 'AI provider for "Explain conflicts with AI"', ignoreFocusOut: true },
  );
  if (!picked) {
    return;
  }
  const spec: ProviderSpec = picked.spec;

  if (spec.id === 'custom') {
    const baseUrl = await vscode.window.showInputBox({
      title: 'Custom endpoint — base URL',
      prompt: 'OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama)',
      value: config.get<string>('ai.customBaseUrl', ''),
      ignoreFocusOut: true,
    });
    if (!baseUrl?.trim()) {
      return;
    }
    const model = await vscode.window.showInputBox({
      title: 'Custom endpoint — model ID',
      prompt: 'The model to request, e.g. llama3.3 or anthropic/claude-opus-4-8 (OpenRouter)',
      value: config.get<string>('ai.customModel', ''),
      ignoreFocusOut: true,
    });
    if (!model?.trim()) {
      return;
    }
    await config.update('ai.customBaseUrl', baseUrl.trim(), vscode.ConfigurationTarget.Global);
    await config.update('ai.customModel', model.trim(), vscode.ConfigurationTarget.Global);
  }

  const key = await vscode.window.showInputBox({
    title: `${spec.label} API key`,
    prompt: spec.keyOptional
      ? 'Optional — leave empty for endpoints without authentication. Stored in SecretStorage.'
      : 'Stored securely in VS Code SecretStorage; used only by "Explain conflicts with AI".',
    password: true,
    ignoreFocusOut: true,
    placeHolder: spec.keyPlaceholder,
  });
  if (key === undefined || (!key.trim() && !spec.keyOptional)) {
    return; // dismissed, or a hosted provider without a key — nothing usable to save
  }
  if (key.trim()) {
    await context.secrets.store(secretKeyFor(spec.id), key.trim());
  }
  await config.update('ai.provider', spec.id, vscode.ConfigurationTarget.Global);
  const model = resolveModel(
    config.get<string>('ai.model', 'auto'),
    spec,
    config.get<string>('ai.customModel', ''),
  );
  void vscode.window.showInformationMessage(
    `Merge Forge: AI explanations now use ${spec.label} (${model}).`,
  );
}

/** Clears stored AI keys — pick which providers' keys to remove. */
async function clearAiKeys(context: vscode.ExtensionContext): Promise<void> {
  const stored: Array<{ label: string; secrets: string[] }> = [];
  for (const spec of PROVIDERS) {
    const names = [secretKeyFor(spec.id)];
    if (spec.id === 'anthropic') {
      names.push(API_KEY_SECRET); // the pre-0.4 secret name
    }
    const present = (
      await Promise.all(names.map(async (name) => ((await context.secrets.get(name)) ? name : '')))
    ).filter(Boolean);
    if (present.length > 0) {
      stored.push({ label: spec.label, secrets: present });
    }
  }
  if (stored.length === 0) {
    void vscode.window.showInformationMessage('Merge Forge: no AI API keys are stored.');
    return;
  }
  const picked = await vscode.window.showQuickPick(stored, {
    title: 'Remove stored AI API keys',
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked || picked.length === 0) {
    return;
  }
  for (const entry of picked) {
    for (const name of entry.secrets) {
      await context.secrets.delete(name);
    }
  }
  void vscode.window.showInformationMessage(
    `Merge Forge: removed ${picked.map((p) => p.label).join(', ')} API key${
      picked.length === 1 ? '' : 's'
    }.`,
  );
}

function readAutoOpen(): boolean {
  return vscode.workspace.getConfiguration('mergeForge').get<boolean>('autoOpenOnConflict', false);
}

function readAutoShow(): boolean {
  return vscode.workspace.getConfiguration('mergeForge').get<boolean>('autoShowConflicts', true);
}

/**
 * Dumps what the git layer sees for the current repo. This is how the git layer gets
 * checked by hand against a real conflicted repository.
 */
async function showDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const channel = getOutputChannel();
  context.subscriptions.push(channel);
  channel.show(true);

  const repoRoot = await activeRepoRoot();
  if (!repoRoot) {
    channel.appendLine('No git repository found.');
    return;
  }
  const [conflicted, operation] = await Promise.all([
    listConflicted(repoRoot),
    detectOperation(repoRoot),
  ]);
  channel.appendLine(`repo:      ${repoRoot}`);
  channel.appendLine(
    `operation: ${operation.kind} (swapPresentation=${operation.swapPresentation})`,
  );
  channel.appendLine(`conflicted (${conflicted.length}):`);
  for (const path of conflicted) {
    const stages = await readStages(repoRoot, path).catch(() => undefined);
    const present = stages
      ? (['base', 'ours', 'theirs'] as const).filter((name) => stages[name]).join(', ')
      : 'unreadable';
    channel.appendLine(`  ${path} — stages: ${present}`);
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
