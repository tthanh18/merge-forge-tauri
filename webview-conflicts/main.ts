import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import './styles.css';
import type {
  ConflictFileEntry,
  ConflictsData,
  ConflictsToHostMessage,
  HostToConflictsMessage,
} from '../src/protocol';

/**
 * The Conflicts dialog: JetBrains' file-list modal, as a webview. Deliberately plain —
 * a grouped table, multi-select, and three actions. All git work happens on the host.
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

function post(message: ConflictsToHostMessage): void {
  vscodeApi.postMessage(message);
}

const app = document.getElementById('app');
if (!app) {
  throw new Error('missing #app root');
}

let data: ConflictsData | undefined;
const selected = new Set<string>();
const collapsedDirs = new Set<string>();
let groupByDirectory = true;
/** Anchor for shift-click range selection, over the currently visible flat order. */
let anchorPath: string | undefined;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Codicon name per file type — an approximation of VS Code's file icons. */
const FILE_ICONS: Record<string, string> = {
  ts: 'file-code',
  tsx: 'file-code',
  js: 'file-code',
  jsx: 'file-code',
  mjs: 'file-code',
  cjs: 'file-code',
  py: 'file-code',
  go: 'file-code',
  rs: 'file-code',
  java: 'file-code',
  json: 'json',
  md: 'markdown',
  vue: 'code',
  html: 'code',
  svelte: 'code',
  xml: 'code',
  css: 'symbol-color',
  scss: 'symbol-color',
  less: 'symbol-color',
  png: 'file-media',
  jpg: 'file-media',
  jpeg: 'file-media',
  gif: 'file-media',
  svg: 'file-media',
  webp: 'file-media',
  ico: 'file-media',
};

function iconFor(path: string): string {
  const name = nameOf(path);
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return FILE_ICONS[ext] ?? 'file';
}

/** Files in display order, honouring grouping — the order shift-selection ranges over. */
function visibleOrder(): ConflictFileEntry[] {
  if (!data) {
    return [];
  }
  if (!groupByDirectory) {
    return [...data.files].sort((a, b) => a.path.localeCompare(b.path));
  }
  const groups = new Map<string, ConflictFileEntry[]>();
  for (const file of data.files) {
    const dir = dirOf(file.path);
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups.keys()]
    .sort()
    .flatMap((dir) =>
      collapsedDirs.has(dir) ? [] : groups.get(dir)!.sort((a, b) => a.path.localeCompare(b.path)),
    );
}

function select(file: ConflictFileEntry, event: MouseEvent): void {
  const order = visibleOrder();
  if (event.shiftKey && anchorPath) {
    const from = order.findIndex((f) => f.path === anchorPath);
    const to = order.findIndex((f) => f.path === file.path);
    if (from !== -1 && to !== -1) {
      selected.clear();
      for (const entry of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        selected.add(entry.path);
      }
      render();
      return;
    }
  }
  if (event.metaKey || event.ctrlKey) {
    if (selected.has(file.path)) {
      selected.delete(file.path);
    } else {
      selected.add(file.path);
    }
  } else {
    selected.clear();
    selected.add(file.path);
  }
  anchorPath = file.path;
  render();
}

function statusCell(status: string): HTMLElement {
  const cell = element('span', 'cf-status', status);
  if (status === 'Deleted') {
    cell.classList.add('cf-deleted');
  } else if (status === 'Added') {
    cell.classList.add('cf-added');
  }
  return cell;
}

function fileRow(file: ConflictFileEntry, indent: boolean): HTMLElement {
  const row = element('div', 'cf-row');
  if (selected.has(file.path)) {
    row.classList.add('cf-selected');
  }
  const name = element('span', `cf-name${indent ? ' cf-indent' : ''}`);
  name.append(
    element('span', `codicon codicon-${iconFor(file.path)} cf-file-icon`),
    element('span', undefined, groupByDirectory ? nameOf(file.path) : file.path),
  );
  name.title = file.path;
  row.append(name, statusCell(file.yours), statusCell(file.theirs));
  row.addEventListener('mousedown', (event) => select(file, event));
  row.addEventListener('dblclick', () => {
    // A delete/modify row has no three-pane view — it gets the keep-or-delete prompt.
    post(
      file.mergeable
        ? { type: 'openMerge', payload: { path: file.path } }
        : { type: 'resolveDeleteModify', payload: { path: file.path } },
    );
  });
  return row;
}

function table(): HTMLElement {
  const container = element('div', 'cf-table');
  const head = element('div', 'cf-head');
  head.append(
    element('span', undefined, 'Name'),
    element('span', undefined, `Yours (${data?.branches.yours ?? ''})`),
    element('span', undefined, `Theirs (${data?.branches.theirs ?? ''})`),
  );
  container.append(head);

  if (!groupByDirectory) {
    for (const file of visibleOrder()) {
      container.append(fileRow(file, false));
    }
    return container;
  }

  const groups = new Map<string, ConflictFileEntry[]>();
  for (const file of data?.files ?? []) {
    const dir = dirOf(file.path);
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  for (const dir of [...groups.keys()].sort()) {
    const files = groups.get(dir)!.sort((a, b) => a.path.localeCompare(b.path));
    const header = element('div', 'cf-dir');
    if (collapsedDirs.has(dir)) {
      header.classList.add('cf-collapsed');
    }
    header.append(
      element('span', 'cf-twist', '▼'),
      element('span', undefined, dir === '' ? '(repository root)' : dir),
      element('span', 'cf-count', `${files.length} file${files.length === 1 ? '' : 's'}`),
    );
    header.addEventListener('click', () => {
      if (collapsedDirs.has(dir)) {
        collapsedDirs.delete(dir);
      } else {
        collapsedDirs.add(dir);
      }
      render();
    });
    container.append(header);
    if (!collapsedDirs.has(dir)) {
      for (const file of files) {
        container.append(fileRow(file, true));
      }
    }
  }
  return container;
}

function actions(): HTMLElement {
  const column = element('div', 'cf-actions');
  const chosen = (data?.files ?? []).filter((f) => selected.has(f.path));

  const acceptYours = element('button', undefined, 'Accept Yours');
  const acceptTheirs = element('button', undefined, 'Accept Theirs');
  // For one delete/modify file the primary action is the keep-or-delete prompt instead.
  const singleDeleteModify = chosen.length === 1 && !chosen[0]!.mergeable;
  const merge = element('button', 'cf-primary', singleDeleteModify ? 'Resolve…' : 'Merge…');

  acceptYours.disabled = chosen.length === 0;
  acceptTheirs.disabled = chosen.length === 0;
  // The three-pane editor needs exactly one file with content on both sides.
  merge.disabled = chosen.length !== 1;
  if (singleDeleteModify) {
    merge.title = 'Deleted on one side — decide whether to keep or delete the file';
  }

  acceptYours.addEventListener('click', () =>
    post({ type: 'acceptSide', payload: { paths: chosen.map((f) => f.path), side: 'yours' } }),
  );
  acceptTheirs.addEventListener('click', () =>
    post({ type: 'acceptSide', payload: { paths: chosen.map((f) => f.path), side: 'theirs' } }),
  );
  merge.addEventListener('click', () =>
    post(
      singleDeleteModify
        ? { type: 'resolveDeleteModify', payload: { path: chosen[0]!.path } }
        : { type: 'openMerge', payload: { path: chosen[0]!.path } },
    ),
  );

  column.append(acceptYours, acceptTheirs, merge);
  return column;
}

function render(): void {
  if (!data) {
    return;
  }
  for (const path of [...selected]) {
    if (!data.files.some((f) => f.path === path)) {
      selected.delete(path); // resolved elsewhere; drop it from the selection
    }
  }

  const verb =
    data.operation === 'rebase'
      ? 'Rebasing'
      : data.operation === 'cherry-pick'
        ? 'Cherry-picking'
        : 'Merging';
  const title = element('div', 'cf-title');
  title.append(
    document.createTextNode(`${verb} branch `),
    element('b', undefined, data.branches.theirs),
    document.createTextNode(' into branch '),
    element('b', undefined, data.branches.yours),
  );
  if (data.totalAtStart > 0) {
    const resolved = data.totalAtStart - data.files.length;
    title.append(element('span', 'cf-progress', `${resolved} of ${data.totalAtStart} resolved`));
  }

  const body = element('div', 'cf-body');
  if (data.files.length === 0) {
    const done = element('div', 'cf-done');
    done.append(
      element('span', undefined, '✓ All conflicts resolved'),
      element('span', undefined, 'You can commit the result now.'),
    );
    body.append(done);
  } else {
    body.append(table(), actions());
  }

  const footer = element('div', 'cf-footer');
  const groupLabel = element('label');
  const groupToggle = element('input') as HTMLInputElement;
  groupToggle.type = 'checkbox';
  groupToggle.checked = groupByDirectory;
  groupToggle.addEventListener('change', () => {
    groupByDirectory = groupToggle.checked;
    render();
  });
  groupLabel.append(groupToggle, document.createTextNode(' Group files by directory'));
  const close = element('button', undefined, 'Close');
  close.addEventListener('click', () => post({ type: 'close' }));
  footer.append(groupLabel, close);

  app!.replaceChildren(title, body, footer);
}

window.addEventListener('message', (event: MessageEvent<HostToConflictsMessage>) => {
  if (event.data.type === 'conflicts') {
    data = event.data.payload;
    render();
  }
});

// Keyboard: arrows walk the visible (grouped) order, Enter merges a single mergeable
// selection, Space toggles multi-select membership like a cmd-click.
window.addEventListener('keydown', (event) => {
  const order = visibleOrder();
  if (order.length === 0) {
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const currentIndex = anchorPath ? order.findIndex((f) => f.path === anchorPath) : -1;
    const nextIndex = Math.min(
      order.length - 1,
      Math.max(0, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    const target = order[nextIndex]!;
    selected.clear();
    selected.add(target.path);
    anchorPath = target.path;
    render();
    [...document.querySelectorAll('.cf-row')]
      .find((row) => (row.querySelector('.cf-name') as HTMLElement)?.title === target.path)
      ?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (event.key === 'Enter') {
    const chosen = order.filter((f) => selected.has(f.path));
    if (chosen.length === 1) {
      event.preventDefault();
      post(
        chosen[0]!.mergeable
          ? { type: 'openMerge', payload: { path: chosen[0]!.path } }
          : { type: 'resolveDeleteModify', payload: { path: chosen[0]!.path } },
      );
    }
    return;
  }
  if (event.key === ' ' && anchorPath) {
    event.preventDefault();
    if (selected.has(anchorPath) && selected.size > 1) {
      selected.delete(anchorPath);
    } else {
      selected.add(anchorPath);
    }
    render();
  }
});

post({ type: 'ready' });
