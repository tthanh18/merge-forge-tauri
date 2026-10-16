import type { Chunk } from '../src/merge/chunk';
import type { WhitespaceMode } from '../src/merge/engine';

/** How changed regions are emphasized: word-level detail or line backgrounds only. */
export type HighlightMode = 'words' | 'lines';

export interface ToolbarActions {
  /** Applies every non-conflicting change AND magic-resolves both-inserted conflicts. */
  applyAllNonConflicting: () => void;
  applyNonConflictingFrom: (side: 'left' | 'right') => void;
  next: () => void;
  previous: () => void;
  setWhitespace: (mode: WhitespaceMode) => void;
  setHighlight: (mode: HighlightMode) => void;
  explain: () => void;
  /** Everything in one click: safe changes mechanically, conflicts via AI. */
  fixAll: () => void;
  /** Swaps the panes for the chronological two-lane commit timeline, and back. */
  toggleHistory: () => void;
  /** Soft-wraps long lines in all three panes, and back. */
  toggleWrap: () => void;
}

export interface FooterActions {
  acceptLeft: () => void;
  acceptRight: () => void;
  apply: () => void;
  cancel: () => void;
}

function button(label: string, title: string, onClick: () => void, primary = false): HTMLElement {
  const node = document.createElement('button');
  node.textContent = label;
  node.title = title;
  if (primary) {
    node.className = 'mf-primary';
  }
  node.addEventListener('click', onClick);
  return node;
}

/** An icon-bearing button using Monaco's bundled codicon font. */
function iconButton(name: string, title: string, onClick: () => void): HTMLElement {
  const node = document.createElement('button');
  node.title = title;
  node.setAttribute('aria-label', title);
  const glyph = document.createElement('span');
  glyph.className = `codicon codicon-${name}`;
  node.append(glyph);
  node.addEventListener('click', onClick);
  return node;
}

function select<T extends string>(
  title: string,
  options: Array<[T, string]>,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const node = document.createElement('select');
  node.title = title;
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    node.append(option);
  }
  node.addEventListener('change', () => onChange(node.value as T));
  return node;
}

function separator(): HTMLElement {
  const node = document.createElement('span');
  node.className = 'mf-sep';
  return node;
}

export interface Toolbar {
  /** `currentIndex` is the 1-based position of the current chunk, for "Change 2 of 6". */
  update: (chunks: readonly Chunk[], currentIndex?: number) => void;
  /** Reverts the whitespace dropdown, for when the user cancels the recompute. */
  setWhitespaceValue: (mode: WhitespaceMode) => void;
  /** Marks the history toggle active while the timeline is shown. */
  setHistoryActive: (active: boolean) => void;
  /** Marks the word-wrap toggle active. */
  setWrapActive: (active: boolean) => void;
}

/** The JetBrains-style toolbar: nav, bulk-apply group, dropdowns, counter on the right. */
export function buildToolbar(
  host: HTMLElement,
  counter: HTMLElement,
  actions: ToolbarActions,
): Toolbar {
  const previous = iconButton('arrow-up', 'Previous change (Shift+F7)', actions.previous);
  const next = iconButton('arrow-down', 'Next change (F7)', actions.next);

  const applyLabel = document.createElement('span');
  applyLabel.className = 'mf-toolbar-label';
  applyLabel.textContent = 'Apply non-conflicting changes:';
  const fromLeft = iconButton(
    'arrow-right',
    'Apply non-conflicting changes from the left side',
    () => actions.applyNonConflictingFrom('left'),
  );
  const fromRight = iconButton(
    'arrow-left',
    'Apply non-conflicting changes from the right side',
    () => actions.applyNonConflictingFrom('right'),
  );
  const applyAll = iconButton(
    'wand',
    'Apply all non-conflicting changes',
    actions.applyAllNonConflicting,
  );
  const explain = iconButton('sparkle', 'Explain conflicts with AI', actions.explain);
  const fixAll = iconButton(
    'run-all',
    'Fix all with AI — apply safe changes, AI-resolve conflicts',
    actions.fixAll,
  );
  const history = iconButton(
    'history',
    'Show file history — who committed which change, and when',
    actions.toggleHistory,
  );
  const wrap = iconButton('word-wrap', 'Toggle word wrap in all panes', actions.toggleWrap);

  const whitespace = select<WhitespaceMode>(
    'How whitespace differences are treated when comparing',
    [
      ['exact', 'Do not ignore'],
      ['trim', 'Trim whitespaces'],
      ['ignoreAll', 'Ignore whitespaces'],
      ['ignoreAllAndEmpty', 'Ignore whitespaces and empty lines'],
    ],
    actions.setWhitespace,
  );
  const highlight = select<HighlightMode>(
    'How differences are highlighted',
    [
      ['words', 'Highlight words'],
      ['lines', 'Highlight lines'],
    ],
    actions.setHighlight,
  );

  host.append(
    previous,
    next,
    separator(),
    applyLabel,
    fromLeft,
    fromRight,
    applyAll,
    separator(),
    explain,
    fixAll,
    history,
    separator(),
    whitespace,
    highlight,
    wrap,
    counter,
  );

  return {
    update(chunks, currentIndex) {
      const pending = chunks.filter((c) => c.state === 'initial');
      const nonConflicting = pending.filter((c) => c.kind !== 'conflict').length;
      const conflicts = pending.filter((c) => c.kind === 'conflict').length;

      const noneLeft = nonConflicting === 0;
      applyAll.toggleAttribute('disabled', noneLeft);
      fromLeft.toggleAttribute('disabled', noneLeft);
      fromRight.toggleAttribute('disabled', noneLeft);
      // A disabled button should say why, not just refuse.
      applyAll.title = noneLeft
        ? 'Nothing non-conflicting left to apply'
        : 'Apply all non-conflicting changes';
      fromLeft.title = noneLeft
        ? 'Nothing non-conflicting left to apply'
        : 'Apply non-conflicting changes from the left side';
      fromRight.title = noneLeft
        ? 'Nothing non-conflicting left to apply'
        : 'Apply non-conflicting changes from the right side';
      previous.toggleAttribute('disabled', chunks.length === 0);
      next.toggleAttribute('disabled', chunks.length === 0);

      const noConflicts = conflicts === 0;
      explain.toggleAttribute('disabled', noConflicts);
      explain.title = noConflicts
        ? 'No unresolved conflicts to explain'
        : 'Explain conflicts with AI';

      fixAll.toggleAttribute('disabled', pending.length === 0);
      fixAll.title =
        pending.length === 0
          ? 'Nothing left to fix'
          : 'Fix all with AI — apply safe changes, AI-resolve conflicts';

      counter.classList.toggle('mf-done', pending.length === 0);
      if (chunks.length === 0) {
        counter.textContent = 'No differences';
      } else if (pending.length === 0) {
        counter.textContent = '✓ All changes processed';
      } else {
        // With a current chunk: "Change 2 of 6 · 3 pending · 1 conflict".
        // Otherwise the JetBrains phrasing: "6 changes. 1 conflict."
        const parts =
          currentIndex !== undefined
            ? [
                `Change ${currentIndex} of ${chunks.length}`,
                `${pending.length} pending`,
                ...(conflicts > 0 ? [`${conflicts} conflict${conflicts === 1 ? '' : 's'}`] : []),
              ]
            : [
                `${pending.length} change${pending.length === 1 ? '' : 's'}.`,
                ...(conflicts > 0 ? [`${conflicts} conflict${conflicts === 1 ? '' : 's'}.`] : []),
              ];
        counter.textContent = parts.join(currentIndex !== undefined ? ' · ' : ' ');
      }
    },
    setWhitespaceValue(mode) {
      whitespace.value = mode;
    },
    setHistoryActive(active) {
      history.classList.toggle('mf-toggled', active);
      history.title = active
        ? 'Back to the merge view (Esc)'
        : 'Show file history — who committed which change, and when';
    },
    setWrapActive(active) {
      wrap.classList.toggle('mf-toggled', active);
    },
  };
}

/** Footer per the screenshots: whole-file accepts on the left, Cancel/Apply on the right. */
export function buildFooter(host: HTMLElement, actions: FooterActions): void {
  const spacer = document.createElement('span');
  spacer.className = 'mf-spacer';
  host.append(
    button(
      'Accept Left',
      "Resolve the whole file with the left side's version",
      actions.acceptLeft,
    ),
    button(
      'Accept Right',
      "Resolve the whole file with the right side's version",
      actions.acceptRight,
    ),
    spacer,
    button('Cancel', 'Close without changing the conflicted file', actions.cancel),
    button('Apply', 'Save the result and mark the file resolved', actions.apply, true),
  );
}
