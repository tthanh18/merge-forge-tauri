import './styles.css';
import type { Chunk } from '../src/merge/chunk';
import { computeChunks, splitLines, type WhitespaceMode } from '../src/merge/engine';
import { chunkTexts, nonConflictingAction, sideControls } from '../src/merge/resolve';
import { wordHighlights } from '../src/merge/wordDiff';
import type {
  AuthorInfo,
  Eol,
  ExplainRequest,
  HostToWebviewMessage,
  InitPayload,
  MergeAction,
  WebviewToHostMessage,
  WorkSnapshot,
} from '../src/protocol';
import { baseLineNumbers, computeSegments, computeSpacers } from './alignment';
import { AuthorChips, chipContent, relativeDate } from './authorChips';
import { Connectors } from './connectors';
import { renderDecorations, type ChunkWordRanges } from './decorations';
import { createPanes, type Panes } from './editors';
import { createExplainDrawer, type ExplainDrawer } from './explainDrawer';
import { createHistoryView, type HistoryView } from './historyView';
import { buildLayout } from './layout';
import { configureMonacoWorker } from './monaco';
import type { monaco } from './monaco';
import type { PaneName } from './panes';
import { syncScrolling } from './scrollSync';
import { ChunkStore } from './state';
import { applyTheme, watchTheme } from './theme';
import { buildFooter, buildToolbar, type HighlightMode, type Toolbar } from './toolbar';
import { applySpacers, emptyZoneIds } from './viewZones';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

function post(message: WebviewToHostMessage): void {
  vscodeApi.postMessage(message);
}

const app = document.getElementById('app');
if (!app) {
  throw new Error('missing #app root');
}

interface Session {
  payload: InitPayload;
  layout: ReturnType<typeof buildLayout>;
  panes: Panes;
  store: ChunkStore;
  chunks: Chunk[];
  wordRanges: Map<number, ChunkWordRanges>;
  whitespace: WhitespaceMode;
  highlight: HighlightMode;
  connectors: { left: Connectors; right: Connectors };
  authorChips: AuthorChips;
  collections: Record<PaneName, monaco.editor.IEditorDecorationsCollection>;
  zoneIds: ReturnType<typeof emptyZoneIds>;
  toolbar: Toolbar;
  zone: Eol;
  /** Navigation emphasis: the chunk you last jumped to, and the transient arrival flash. */
  currentChunkId: number | undefined;
  flashChunkId: number | undefined;
  /** Chunk under the pointer (band or controls); never snapshotted. */
  hoverChunkId: number | undefined;
}

let session: Session | undefined;
let drawer: ExplainDrawer | undefined;
let historyView: HistoryView | undefined;
/** Set while a history request is in flight, so the answer opens the view once. */
let historyPending = false;
let cursor = -1;
let flashTimer: number | undefined;
/** Last applied base↔center mapping, so the margin only repaints when ranges move. */
let lineNumbersSignature = '';

/** Word-level emphasis per chunk, computed once — base and side texts never change. */
function computeWordRanges(chunks: readonly Chunk[], payload: InitPayload) {
  const map = new Map<number, ChunkWordRanges>();
  const baseLines = splitLines(payload.base);
  const leftLines = splitLines(payload.left);
  const rightLines = splitLines(payload.right);
  for (const chunk of chunks) {
    const baseSlice = baseLines.slice(chunk.base.start, chunk.base.end);
    map.set(chunk.id, {
      left:
        chunk.leftSubtype === 'modified'
          ? wordHighlights(baseSlice, leftLines.slice(chunk.left.start, chunk.left.end))
          : [],
      right:
        chunk.rightSubtype === 'modified'
          ? wordHighlights(baseSlice, rightLines.slice(chunk.right.start, chunk.right.end))
          : [],
    });
  }
  return map;
}

/**
 * Recomputes layout and repaints from current state.
 *
 * Strictly one-way — state → segments → zones → decorations → connectors — and everything
 * that mutates state routes through here rather than touching editors directly. That is
 * what stops the edit → track → align cycle from feeding back on itself.
 */
function refresh(): void {
  if (!session) {
    return;
  }
  const { panes, chunks, store } = session;
  const centerRanges = store.centerRanges();
  const totals = {
    left: panes.left.getModel()?.getLineCount() ?? 0,
    center: panes.center.getModel()?.getLineCount() ?? 0,
    right: panes.right.getModel()?.getLineCount() ?? 0,
  };
  applySpacers(
    panes,
    computeSpacers(computeSegments(chunks, centerRanges, totals)),
    session.zoneIds,
  );
  renderDecorations(
    chunks,
    centerRanges,
    session.collections,
    session.highlight === 'words' ? session.wordRanges : undefined,
    {
      currentChunkId: session.currentChunkId,
      flashChunkId: session.flashChunkId,
      hoverChunkId: session.hoverChunkId,
    },
  );
  redrawConnectors();
  updateBaseLineNumbers(centerRanges);
  const currentPosition = chunks.findIndex((c) => c.id === session!.currentChunkId);
  session.toolbar.update(chunks, currentPosition >= 0 ? currentPosition + 1 : undefined);
  // WebStorm's completion card: floats over the result once nothing needs deciding,
  // and disappears again the moment any chunk reopens (e.g. via undo).
  const allProcessed = chunks.length > 0 && chunks.every((c) => c.state !== 'initial');
  session.layout.doneCard.classList.toggle('mf-hidden', !allProcessed);
  postState();
}

/**
 * JetBrains shows the original (base) line number next to the current one in the
 * result pane. Rebuilding the renderer forces a margin repaint, so it only happens
 * when a chunk's mapping actually moved — not on hover or flash refreshes.
 */
function updateBaseLineNumbers(centerRanges: ReadonlyMap<number, { start: number; end: number }>) {
  if (!session) {
    return;
  }
  const signature = session.chunks
    .map((chunk) => {
      const range = centerRanges.get(chunk.id);
      return `${chunk.id}:${chunk.base.start}-${chunk.base.end}:${range?.start}-${range?.end}`;
    })
    .join(',');
  if (signature === lineNumbersSignature) {
    return;
  }
  lineNumbersSignature = signature;
  const baseTotal = splitLines(session.payload.base).length;
  const baseFor = baseLineNumbers(session.chunks, centerRanges, baseTotal);
  session.panes.center.updateOptions({
    lineNumbersMinChars: 7,
    lineNumbers: (lineNumber: number) => {
      const base = baseFor(lineNumber);
      return base === '' ? String(lineNumber) : `${base} ${lineNumber}`;
    },
  });
}

/**
 * Hover must not rebuild the gutter buttons. A full refresh replaces the element under
 * the pointer; WebKit then emits mouseleave for the removed button and the next enter
 * refreshes again, so the click never lands and the side is never copied into the result.
 */
function paintHover(): void {
  if (!session) {
    return;
  }
  const centerRanges = session.store.centerRanges();
  renderDecorations(
    session.chunks,
    centerRanges,
    session.collections,
    session.highlight === 'words' ? session.wordRanges : undefined,
    {
      currentChunkId: session.currentChunkId,
      flashChunkId: session.flashChunkId,
      hoverChunkId: session.hoverChunkId,
    },
  );
  session.connectors.left.setHover(session.hoverChunkId);
  session.connectors.right.setHover(session.hoverChunkId);
}

function redrawConnectors(): void {
  if (!session) {
    return;
  }
  const centerRanges = session.store.centerRanges();
  const emphasis = {
    currentChunkId: session.currentChunkId,
    flashChunkId: session.flashChunkId,
    hoverChunkId: session.hoverChunkId,
  };
  session.connectors.left.render(session.chunks, centerRanges, emphasis);
  session.connectors.right.render(session.chunks, centerRanges, emphasis);
  session.authorChips.render(session.chunks);
}

let wrapOn = false;

/** Soft wrap in all three panes; geometry re-renders because line heights change. */
function toggleWrap(): void {
  if (!session) {
    return;
  }
  wrapOn = !wrapOn;
  for (const pane of [session.panes.left, session.panes.center, session.panes.right]) {
    pane.updateOptions({ wordWrap: wrapOn ? 'on' : 'off' });
  }
  session.toolbar.setWrapActive(wrapOn);
  redrawConnectors();
}

/** The history toggle: request data on open (host caches), restore panes on close. */
function toggleHistory(): void {
  if (!session || !historyView) {
    return;
  }
  if (historyView.isOpen) {
    historyView.hide();
    session.layout.panesRow.classList.remove('mf-hidden');
    session.toolbar.setHistoryActive(false);
    redrawConnectors();
    return;
  }
  historyPending = true;
  post({ type: 'history' });
}

function showHistory(payload: Parameters<HistoryView['show']>[0]): void {
  if (!session || !historyView || !historyPending) {
    return;
  }
  historyPending = false;
  historyView.show(payload);
  session.layout.panesRow.classList.add('mf-hidden');
  session.toolbar.setHistoryActive(true);
}

/** Asks the host to blame each conflict's side ranges; chips render on the answer. */
function requestBlame(): void {
  if (!session) {
    return;
  }
  const ranges = session.chunks
    .filter((chunk) => chunk.kind === 'conflict')
    .map((chunk) => ({
      chunkId: chunk.id,
      leftStart: chunk.left.start,
      leftEnd: chunk.left.end,
      rightStart: chunk.right.start,
      rightEnd: chunk.right.end,
    }));
  if (ranges.length > 0) {
    post({ type: 'blame', payload: { ranges } });
  }
}

function postState(): void {
  if (!session) {
    return;
  }
  const { chunks } = session;
  const dirty = chunks.some((c) => c.state !== 'initial');
  post({
    type: 'state',
    payload: {
      totalChunks: chunks.length,
      unresolvedConflicts: chunks.filter((c) => c.kind === 'conflict' && c.state === 'initial')
        .length,
      pendingChanges: chunks.filter((c) => c.state === 'initial').length,
      dirty,
    },
  });
  if (dirty) {
    scheduleWorkSnapshot();
  }
}

/** Crash-safety: ship the current work to the host, debounced past the edit burst. */
let workSnapshotTimer: number | undefined;
function scheduleWorkSnapshot(): void {
  window.clearTimeout(workSnapshotTimer);
  workSnapshotTimer = window.setTimeout(() => {
    if (!session) {
      return;
    }
    const snapshot: WorkSnapshot = {
      content: session.store.result(),
      whitespace: session.whitespace,
      chunks: session.chunks.map((chunk) => {
        const range = session!.store.centerRange(chunk.id);
        return {
          id: chunk.id,
          state: chunk.state,
          dismissedLeft: chunk.dismissedLeft,
          dismissedRight: chunk.dismissedRight,
          start: range.start,
          end: range.end,
        };
      }),
    };
    post({ type: 'workSnapshot', payload: snapshot });
  }, 1000);
}

/** The Restore/Discard offer for earlier unsaved work, in the confirm bar. */
function offerRestore(snapshot: WorkSnapshot): void {
  const bar = session?.layout.confirmBar;
  if (!bar || !session) {
    return;
  }
  const finish = (): void => {
    bar.classList.add('mf-hidden');
    bar.replaceChildren();
  };
  const text = document.createElement('span');
  text.textContent = 'You have unsaved work on this merge from an earlier session.';
  const restore = document.createElement('button');
  restore.textContent = 'Restore';
  restore.addEventListener('click', () => {
    if (!session) {
      return;
    }
    // The snapshot's chunk ids only line up under the mode it was taken in.
    if (snapshot.whitespace !== session.whitespace) {
      session.toolbar.setWhitespaceValue(snapshot.whitespace as WhitespaceMode);
      buildSession(snapshot.whitespace as WhitespaceMode);
    }
    session.store.applyWorkSnapshot(snapshot);
    finish();
  });
  const discard = document.createElement('button');
  discard.textContent = 'Discard';
  discard.addEventListener('click', () => {
    post({ type: 'discardWork' });
    finish();
  });
  bar.replaceChildren(text, restore, discard);
  bar.classList.remove('mf-hidden');
}

/** Moves to the next or previous unresolved change and centers it in every pane. */
function navigate(direction: 1 | -1): void {
  if (!session || session.chunks.length === 0) {
    return;
  }
  const { chunks, panes, store } = session;
  const candidates = chunks.filter((c) => c.state === 'initial');
  const pool = candidates.length > 0 ? candidates : chunks;
  cursor = (cursor + direction + pool.length) % pool.length;
  const chunk = pool[cursor];
  if (!chunk) {
    return;
  }
  const centerRange = store.centerRange(chunk.id);
  // ScrollType.Smooth (0) lets the eye follow the jump; the arrival flash marks the
  // destination, then the chunk keeps its "current" outline until the next jump.
  const SMOOTH = 0;
  panes.center.revealLineInCenter(centerRange.start + 1, SMOOTH);
  panes.left.revealLineInCenter(chunk.left.start + 1, SMOOTH);
  panes.right.revealLineInCenter(chunk.right.start + 1, SMOOTH);
  session.currentChunkId = chunk.id;
  session.flashChunkId = chunk.id;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    if (session) {
      session.flashChunkId = undefined;
      refresh();
    }
  }, 750);
  refresh();
}

/** Advances to the next pending chunk, or stays put when nothing is left to decide. */
function navigateToNextUnresolved(): void {
  if (session?.chunks.some((chunk) => chunk.state === 'initial')) {
    navigate(1);
  }
}

/**
 * Runs a resolution action and, when it settles the chunk, hops to the next pending one
 * — accept, accept, accept down the file without reaching for the mouse.
 */
function resolveAndAdvance(run: () => void, chunkId: number): void {
  run();
  const chunk = session?.chunks.find((c) => c.id === chunkId);
  if (chunk && chunk.state !== 'initial') {
    navigateToNextUnresolved();
  }
}

/**
 * Applies every change only one side made. Strictly non-conflicting: a conflict —
 * including two sides inserting different versions of the same new code — never has an
 * automatic answer, and concatenating "both added" variants duplicates real functions
 * (found in the field). Red stays red until a human decides.
 */
function applyAllSafe(): number {
  return session?.store.applyMany((chunk) => nonConflictingAction(chunk)) ?? 0;
}

/**
 * "Fix all with AI": the whole file in one click. Non-conflicting changes are applied
 * mechanically (deterministic, byte-exact — no reason to ask a model); only the red
 * conflicts go to the AI. The drawer report combines both counts.
 */
let fixAllMechanical = 0;
function fixAllWithAi(): void {
  if (!session) {
    return;
  }
  const mechanical = applyAllSafe();
  const conflictsLeft = session.chunks.some((c) => c.kind === 'conflict' && c.state === 'initial');
  if (conflictsLeft) {
    fixAllMechanical = mechanical;
    requestAiResolve();
  }
  // No conflicts: the wand already settled everything; the done card takes it from here.
}

function runAction(action: MergeAction): void {
  if (!session) {
    return;
  }
  switch (action) {
    case 'nextChange':
      navigate(1);
      break;
    case 'prevChange':
      navigate(-1);
      break;
    case 'applyAllNonConflicting':
      applyAllSafe();
      break;
    case 'requestApply':
      requestApply();
      break;
  }
}

function requestApply(): void {
  if (!session) {
    return;
  }
  post({ type: 'apply', payload: { content: session.store.result(), eol: session.zone } });
}

/**
 * The unresolved conflicts (base + both sides) as an AI request, or undefined when none.
 * With `onlyChunkId`, a single-conflict request — the ✦ menu's scope — keeping the
 * chunk's position-based number so headings match the whole-file numbering.
 */
function buildAiRequest(onlyChunkId?: number): ExplainRequest | undefined {
  if (!session) {
    return undefined;
  }
  const { payload } = session;
  const unresolved = session.chunks.filter((c) => c.kind === 'conflict' && c.state === 'initial');
  const conflicts =
    onlyChunkId === undefined ? unresolved : unresolved.filter((c) => c.id === onlyChunkId);
  if (conflicts.length === 0) {
    return undefined;
  }
  return {
    filePath: payload.filePath,
    languageId: payload.languageId,
    labels: payload.labels,
    // The current result document — the model's rich baseline around the conflicts.
    resultText: session.store.result(),
    conflicts: conflicts.map((chunk) => {
      const position = unresolved.indexOf(chunk);
      // Lines are terminator-inclusive, so joining with '' reconstructs the exact text.
      const texts = chunkTexts(chunk, payload.base, payload.left, payload.right);
      const range = session!.store.centerRange(chunk.id);
      return {
        index: position + 1,
        chunkId: chunk.id,
        baseText: texts.base.join(''),
        leftText: texts.left.join(''),
        rightText: texts.right.join(''),
        resultStart: range.start,
        resultEnd: range.end,
      };
    }),
  };
}

function requestExplain(): void {
  const request = buildAiRequest();
  if (!request || !drawer) {
    return;
  }
  drawer.openLoading(request.conflicts.length);
  post({ type: 'explain', payload: request });
}

/** "Resolve with AI": ask for merged code and let `applyAiResolutions` place it. */
function requestAiResolve(onlyChunkId?: number): void {
  const request = buildAiRequest(onlyChunkId);
  if (!request || !drawer) {
    return;
  }
  const explanation = drawer.explanationText();
  drawer.setResolving(true);
  post({
    type: 'aiResolve',
    payload: { request, ...(explanation.trim() !== '' ? { explanation } : {}) },
  });
}

/** Follow-up chat: prior turns, folded into each new question's prompt on the host. */
const chatHistory: Array<{ question: string; answer: string }> = [];
let pendingAsk: { question: string; answer: string } | undefined;

function requestAiAsk(question: string): void {
  const request = buildAiRequest();
  if (!request || !drawer) {
    return;
  }
  pendingAsk = { question, answer: '' };
  drawer.askStart(question);
  post({ type: 'aiAsk', payload: { request, history: [...chatHistory], question } });
}

/** The ✦ menu on a conflict: Explain / Resolve scoped to that one chunk. */
let aiMenu: HTMLElement | undefined;
function closeAiMenu(): void {
  aiMenu?.remove();
  aiMenu = undefined;
}

function openAiMenu(chunkId: number, anchor: DOMRect): void {
  closeAiMenu();
  const menu = document.createElement('div');
  menu.className = 'mf-ai-menu';
  const item = (label: string, run: () => void): HTMLElement => {
    const node = document.createElement('button');
    node.textContent = label;
    node.addEventListener('click', () => {
      closeAiMenu();
      run();
    });
    return node;
  };
  menu.append(
    item('✦ Explain this conflict', () => {
      const request = buildAiRequest(chunkId);
      if (request && drawer) {
        drawer.openLoading(request.conflicts.length);
        post({ type: 'explain', payload: request });
      }
    }),
    item('✦ Resolve this conflict', () => requestAiResolve(chunkId)),
  );
  document.body.append(menu);
  // Anchor beside the glyph, clamped into the viewport.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(anchor.right + 4, window.innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(anchor.top, window.innerHeight - height - 8)}px`;
  aiMenu = menu;
}

// --- author popover ---------------------------------------------------------------

let authorPop: HTMLElement | undefined;

function closeAuthorPop(): void {
  authorPop?.remove();
  authorPop = undefined;
}

/** The identity card behind a chip or timeline row: who, when, what — and links. */
function openAuthorPop(author: AuthorInfo, anchor: DOMRect): void {
  closeAuthorPop();
  closeAiMenu();
  const pop = document.createElement('div');
  pop.className = 'mf-author-pop';

  const head = document.createElement('div');
  head.className = 'mf-author-pop-head';
  const avatar = document.createElement('span');
  avatar.className = 'mf-author-chip mf-author-chip-static';
  avatar.append(chipContent(author));
  const name = document.createElement('span');
  name.className = 'mf-author-pop-name';
  name.textContent = author.name;
  head.append(avatar, name);

  const meta = document.createElement('div');
  meta.className = 'mf-author-pop-meta';
  meta.textContent = `${relativeDate(author.timestamp)} · ${author.shortSha}`;
  const subject = document.createElement('div');
  subject.className = 'mf-author-pop-subject';
  subject.textContent = author.subject;

  pop.append(head, meta, subject);
  const link = (href: string, label: string): HTMLElement => {
    const a = document.createElement('a');
    a.className = 'mf-author-pop-link';
    a.href = href;
    a.textContent = label;
    return a;
  };
  if (author.commitUrl) {
    pop.append(link(author.commitUrl, '→ Open commit on GitHub'));
  }
  if (author.profileUrl) {
    pop.append(link(author.profileUrl, '→ Open GitHub profile'));
  }
  const email = document.createElement('button');
  email.className = 'mf-author-pop-email';
  email.textContent = author.email;
  email.title = 'Click to copy';
  email.addEventListener('click', () => {
    void navigator.clipboard?.writeText(author.email);
    email.textContent = 'Copied!';
    window.setTimeout(() => (email.textContent = author.email), 1200);
  });
  pop.append(email);

  document.body.append(pop);
  const { width, height } = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(anchor.right + 6, window.innerWidth - width - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))}px`;
  authorPop = pop;
}

window.addEventListener(
  'mousedown',
  (event) => {
    if (aiMenu && !aiMenu.contains(event.target as Node)) {
      closeAiMenu();
    }
    if (authorPop && !authorPop.contains(event.target as Node)) {
      closeAuthorPop();
    }
  },
  { capture: true },
);

/**
 * Places the AI's merged blocks into the result. Bottom-up by current position, so an
 * earlier replacement never shifts a later chunk's range mid-flight; chunks the user
 * decided while the request ran are left alone.
 */
function applyAiResolutions(
  resolutions: ReadonlyArray<{ chunkId: number; text: string }>,
  missing: number,
): void {
  if (!session || !drawer) {
    return;
  }
  const { store } = session;
  const ordered = [...resolutions].sort(
    (a, b) => store.centerRange(b.chunkId).start - store.centerRange(a.chunkId).start,
  );
  let applied = 0;
  for (const resolution of ordered) {
    if (store.replaceText(resolution.chunkId, resolution.text)) {
      applied++;
    }
  }
  const remaining = session.chunks.filter(
    (c) => c.kind === 'conflict' && c.state === 'initial',
  ).length;
  drawer.showResolveReport(applied, resolutions.length + missing, remaining, fixAllMechanical);
  fixAllMechanical = 0;
}

/**
 * Builds (or rebuilds) the chunk model over the existing panes. Rebuilding happens when
 * the whitespace mode changes: the center resets to base and every decision starts over,
 * because chunks computed under one mode don't map onto ranges computed under another.
 */
function buildSession(whitespace: WhitespaceMode): void {
  if (!session) {
    return;
  }
  session.store.dispose();
  session.panes.center.getModel()?.setValue(session.payload.base);

  const chunks = computeChunks(session.payload.base, session.payload.left, session.payload.right, {
    whitespace,
  });
  session.chunks = chunks;
  session.whitespace = whitespace;
  session.wordRanges = computeWordRanges(chunks, session.payload);
  session.store = new ChunkStore(
    chunks,
    session.panes.center,
    session.payload.base,
    session.payload.left,
    session.payload.right,
    () => refresh(),
  );
  cursor = -1;
  session.currentChunkId = undefined;
  session.flashChunkId = undefined;
  lineNumbersSignature = '';
  // Chunk ids changed with the recompute; stale authorship must not mis-attach.
  session.authorChips.setData([]);
  refresh();
  requestBlame();
}

/** Asks an inline yes/no in the confirm bar; resolves false on cancel. */
function confirmInBar(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const bar = session?.layout.confirmBar;
    if (!bar) {
      resolve(false);
      return;
    }
    const finish = (answer: boolean) => {
      bar.classList.add('mf-hidden');
      bar.replaceChildren();
      resolve(answer);
    };
    const text = document.createElement('span');
    text.textContent = message;
    const yes = document.createElement('button');
    yes.textContent = 'Continue';
    yes.addEventListener('click', () => finish(true));
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    no.addEventListener('click', () => finish(false));
    bar.replaceChildren(text, yes, no);
    bar.classList.remove('mf-hidden');
  });
}

async function changeWhitespace(mode: WhitespaceMode): Promise<void> {
  if (!session || mode === session.whitespace) {
    return;
  }
  const hasProgress = session.chunks.some((chunk) => chunk.state !== 'initial');
  if (hasProgress) {
    const proceed = await confirmInBar(
      'Changing whitespace handling recomputes the changes and resets your progress in this file.',
    );
    if (!proceed) {
      session.toolbar.setWhitespaceValue(session.whitespace);
      return;
    }
  }
  buildSession(mode);
}

function start(payload: InitPayload): void {
  const layout = buildLayout(app!, payload.labels, payload.filePath);
  applyTheme();
  watchTheme();

  // The result starts at the base revision — the last state both sides agreed on — so
  // every difference is an explicit decision rather than a silent default to one side.
  const panes = createPanes(
    layout.hosts,
    { left: payload.left, center: payload.base, right: payload.right },
    payload.languageId,
    payload.settings.font,
  );

  const chunks = computeChunks(payload.base, payload.left, payload.right);
  const store = new ChunkStore(
    chunks,
    panes.center,
    payload.base,
    payload.left,
    payload.right,
    () => refresh(),
  );

  const callbacks = {
    onAccept: (chunkId: number, side: 'left' | 'right') => session?.store.acceptSide(chunkId, side),
    onDismiss: (chunkId: number, side: 'left' | 'right') =>
      session?.store.dismissSide(chunkId, side),
    controls: (chunk: Chunk) => sideControls(chunk),
    onHover: (chunkId: number | undefined) => {
      if (session && session.hoverChunkId !== chunkId) {
        session.hoverChunkId = chunkId;
        paintHover();
      }
    },
    onAiMenu: openAiMenu,
  };

  drawer = createExplainDrawer(layout.explainHost, {
    onCancel: () => post({ type: 'explainCancel' }),
    onSetup: () => post({ type: 'openAiSetup' }),
    onResolve: () => requestAiResolve(),
    onAsk: requestAiAsk,
  });

  const toolbar = buildToolbar(layout.toolbar, layout.counter, {
    applyAllNonConflicting: applyAllSafe,
    applyNonConflictingFrom: (side) =>
      session?.store.applyMany((chunk) => nonConflictingAction(chunk, side)),
    next: () => navigate(1),
    previous: () => navigate(-1),
    setWhitespace: (mode) => void changeWhitespace(mode),
    setHighlight: (mode) => {
      if (session) {
        session.highlight = mode;
        refresh();
      }
    },
    explain: requestExplain,
    fixAll: fixAllWithAi,
    toggleHistory,
    toggleWrap,
  });
  historyView = createHistoryView(layout.historyHost, openAuthorPop);
  layout.doneAction.addEventListener('click', requestApply);
  buildFooter(layout.footer, {
    acceptLeft: () => session?.store.acceptAll('left', session.payload.left),
    acceptRight: () => session?.store.acceptAll('right', session.payload.right),
    apply: requestApply,
    cancel: () => post({ type: 'abort' }),
  });

  session = {
    payload,
    layout,
    panes,
    store,
    chunks,
    wordRanges: computeWordRanges(chunks, payload),
    whitespace: 'exact',
    highlight: 'words',
    connectors: {
      left: new Connectors(layout.leftStrip, 'left', panes, callbacks),
      right: new Connectors(layout.rightStrip, 'right', panes, callbacks),
    },
    authorChips: new AuthorChips(
      { left: layout.hosts.left, right: layout.hosts.right },
      panes,
      openAuthorPop,
    ),
    collections: {
      left: panes.left.createDecorationsCollection([]),
      center: panes.center.createDecorationsCollection([]),
      right: panes.right.createDecorationsCollection([]),
    },
    zoneIds: emptyZoneIds(),
    toolbar,
    zone: payload.eol.suggested,
    currentChunkId: undefined,
    flashChunkId: undefined,
    hoverChunkId: undefined,
  };

  syncScrolling(panes, redrawConnectors);
  window.addEventListener('resize', redrawConnectors);

  if (payload.eol.conflict) {
    showEolBanner(layout.banner, payload);
  }
  if (payload.settings.autoApplyNonConflicting) {
    store.applyMany((chunk) => nonConflictingAction(chunk));
  }
  refresh();
  // Land on the first pending change immediately — flash and outline included.
  navigateToNextUnresolved();
  requestBlame();

  // Debug handle for the dev harness (dev/harness*.html); inert inside a real webview.
  (window as unknown as Record<string, unknown>).__mfSession = session;
}

/** Lets the user choose the result's line ending when the sides disagree. */
function showEolBanner(banner: HTMLElement, payload: InitPayload): void {
  banner.classList.remove('mf-hidden');
  const text = document.createElement('span');
  text.textContent =
    `Line endings differ — yours: ${payload.eol.left.toUpperCase()}, ` +
    `theirs: ${payload.eol.right.toUpperCase()}. Save the result as:`;
  banner.append(text);

  for (const eol of ['lf', 'crlf'] as const) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'mf-eol';
    radio.checked = payload.eol.suggested === eol;
    radio.addEventListener('change', () => {
      if (session) {
        session.zone = eol;
      }
    });
    label.append(radio, document.createTextNode(` ${eol.toUpperCase()}`));
    banner.append(label);
  }
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'init' && !session) {
    start(message.payload);
  } else if (message.type === 'runAction') {
    runAction(message.action);
  } else if (message.type === 'explainDelta') {
    if (pendingAsk) {
      pendingAsk.answer += message.text;
    }
    drawer?.appendDelta(message.text);
  } else if (message.type === 'explainActivity') {
    drawer?.appendActivity(message.text);
  } else if (message.type === 'explainDone') {
    if (pendingAsk) {
      chatHistory.push(pendingAsk);
      pendingAsk = undefined;
    }
    drawer?.finish(message.truncated === true);
  } else if (message.type === 'explainError') {
    pendingAsk = undefined;
    drawer?.setResolving(false);
    drawer?.showError(message.message, message.unconfigured === true);
  } else if (message.type === 'aiResolutions') {
    applyAiResolutions(message.resolutions, message.missing);
  } else if (message.type === 'blameResult') {
    session?.authorChips.setData(message.payload);
    redrawConnectors();
  } else if (message.type === 'historyData') {
    showHistory(message.payload);
  } else if (message.type === 'offerRestore') {
    offerRestore(message.payload);
  }
});

// Webviews swallow most keystrokes, so navigation and resolution keys are handled here
// (capture phase, so Monaco doesn't eat them first). F7 also exists as a contributed
// keybinding — whichever gets there first wins.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape' && (aiMenu || authorPop)) {
      event.preventDefault();
      closeAiMenu();
      closeAuthorPop();
      return;
    }
    if (event.key === 'Escape' && historyView?.isOpen) {
      event.preventDefault();
      toggleHistory();
      return;
    }
    // Chunk navigation acts on editors the history view is covering — hold it off.
    if (historyView?.isOpen) {
      return;
    }
    if (event.key === 'F7') {
      event.preventDefault();
      navigate(event.shiftKey ? -1 : 1);
      return;
    }
    // Alt+←/→ take the corresponding side of the CURRENT chunk, then auto-advance.
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const id = session?.currentChunkId;
      const chunk = session?.chunks.find((c) => c.id === id);
      if (id === undefined || !chunk) {
        return;
      }
      const side = event.key === 'ArrowLeft' ? 'left' : 'right';
      const offered = sideControls(chunk);
      if (side === 'left' ? offered.acceptLeft : offered.acceptRight) {
        event.preventDefault();
        event.stopPropagation();
        resolveAndAdvance(() => session?.store.acceptSide(id, side), id);
      }
    }
  },
  { capture: true },
);

// The worker must exist before any editor is created, so `ready` — which triggers `init`,
// which builds the panes — waits for it.
void configureMonacoWorker((message) => post({ type: 'log', level: 'warn', message })).then(() =>
  post({ type: 'ready' }),
);
