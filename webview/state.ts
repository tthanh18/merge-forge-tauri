import type { Chunk, ChunkAction, Side } from '../src/merge/chunk';
import { transition } from '../src/merge/chunk';
import { joinLines, splitLines } from '../src/merge/engine';
import { chunkTexts, resolveAction, textForState, type ChunkTexts } from '../src/merge/resolve';
import type { CenterRange } from './alignment';
import type { monaco } from './monaco';

/** Edits tagged with this source are ours; anything else came from the user. */
const EDIT_SOURCE = 'mergeForge';

/**
 * Owns chunk state and where each chunk lives in the center document.
 *
 * Positions are tracked with Monaco decorations rather than arithmetic: the user can type
 * anywhere in the result, and decorations are the only thing that reliably survives that.
 * Our own edits re-pin their decoration afterwards instead of trusting stickiness, since
 * a replacement's end position depends on how the edit is applied.
 */
/** Chunk states and tracker positions as they were at one exact text version. */
interface Snapshot {
  states: {
    state: Chunk['state'];
    dismissedLeft: boolean;
    dismissedRight: boolean;
  }[];
  ranges: CenterRange[];
}

export class ChunkStore {
  private readonly texts = new Map<number, ChunkTexts>();
  private readonly trackers = new Map<number, string>();
  /**
   * Chunk state at every text version we've seen, keyed by the model's *alternative*
   * version id — Monaco's id that comes back to the same value when undo/redo lands on
   * byte-identical text. Text edits are on Monaco's undo stack but chunk states are not,
   * so this is what lets Cmd+Z restore the whole UI, not just the characters.
   */
  private readonly history = new Map<number, Snapshot>();
  private static readonly HISTORY_LIMIT = 1000;
  private applying = false;
  private contentListener: monaco.IDisposable | undefined;

  constructor(
    readonly chunks: Chunk[],
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    base: string,
    left: string,
    right: string,
    private readonly onChange: () => void,
  ) {
    for (const chunk of chunks) {
      this.texts.set(chunk.id, chunkTexts(chunk, base, left, right));
    }
    this.installTrackers();
    // Seed the initial version, so undoing everything restores the untouched state.
    this.snapshot();
    this.watchUserEdits();
  }

  /** Detaches from the editor so a new store can take over (whitespace-mode rebuild). */
  dispose(): void {
    this.contentListener?.dispose();
    this.model.deltaDecorations([...this.trackers.values()], []);
    this.trackers.clear();
    this.history.clear();
  }

  private snapshot(): void {
    this.history.set(this.model.getAlternativeVersionId(), {
      states: this.chunks.map((chunk) => ({
        state: chunk.state,
        dismissedLeft: chunk.dismissedLeft,
        dismissedRight: chunk.dismissedRight,
      })),
      ranges: this.chunks.map((chunk) => this.centerRange(chunk.id)),
    });
    if (this.history.size > ChunkStore.HISTORY_LIMIT) {
      const oldest = this.history.keys().next().value;
      if (oldest !== undefined) {
        this.history.delete(oldest);
      }
    }
  }

  /**
   * Puts every chunk back exactly as it was at a snapshot's text version. Trackers are
   * re-pinned from the stored ranges rather than trusted: an undo that re-inserts text at
   * a collapsed (deleted-chunk) tracker cannot grow it back through stickiness alone.
   */
  private restore(snapshot: Snapshot): void {
    this.chunks.forEach((chunk, index) => {
      const saved = snapshot.states[index];
      const range = snapshot.ranges[index];
      if (saved !== undefined) {
        chunk.state = saved.state;
        chunk.dismissedLeft = saved.dismissedLeft;
        chunk.dismissedRight = saved.dismissedRight;
      }
      if (range) {
        this.repin(chunk, range.start, range.end - range.start);
      }
    });
  }

  private get model(): monaco.editor.ITextModel {
    const model = this.editor.getModel();
    if (!model) {
      throw new Error('center editor has no model');
    }
    return model;
  }

  /**
   * Places one tracking decoration per chunk. The result pane starts as the base text, so
   * a chunk's initial center range is exactly its base range.
   */
  private installTrackers(): void {
    const model = this.model;
    for (const chunk of this.chunks) {
      const id = model.deltaDecorations(
        [],
        [{ range: toMonacoRange(model, chunk.base), options: { stickiness: STICKINESS } }],
      )[0];
      if (id) {
        this.trackers.set(chunk.id, id);
      }
    }
  }

  /** The chunk's live range in the center document, read back from its decoration. */
  centerRange(chunkId: number): CenterRange {
    const id = this.trackers.get(chunkId);
    const range = id ? this.model.getDecorationRange(id) : null;
    if (!range) {
      const chunk = this.chunks.find((c) => c.id === chunkId);
      return { start: chunk?.base.start ?? 0, end: chunk?.base.end ?? 0 };
    }
    return toCenterRange(range);
  }

  centerRanges(): Map<number, CenterRange> {
    return new Map(this.chunks.map((chunk) => [chunk.id, this.centerRange(chunk.id)]));
  }

  /** The text currently sitting in the chunk's region of the result. */
  private actualText(chunk: Chunk): string {
    return this.model.getValueInRange(toMonacoRange(this.model, this.centerRange(chunk.id)));
  }

  /** The text this chunk should hold for its state, i.e. what we last wrote there. */
  private expectedText(chunk: Chunk): string {
    const texts = this.texts.get(chunk.id);
    return texts ? joinLines(textForState(texts, chunk.state)) : '';
  }

  /**
   * Marks chunks the user typed into as manually edited. A hand-edited conflict counts as
   * decided — that is JetBrains' behavior, and it is what lets you write a blend of the
   * two sides rather than picking one.
   *
   * The test is "does this chunk still contain what we put there?", not "did an edit land
   * near it". Comparing positions means doing interval arithmetic against edit ranges, and
   * getting it slightly wrong marks a *neighbouring* conflict as resolved — which silently
   * clears the unresolved-conflict warning and lets a real conflict reach a commit.
   * Content can't drift like that: an edit outside a chunk moves it without changing it.
   */
  private watchUserEdits(): void {
    this.contentListener = this.model.onDidChangeContent(() => {
      if (this.applying) {
        return;
      }
      const snapshot = this.history.get(this.model.getAlternativeVersionId());
      if (snapshot) {
        // Undo or redo landed on a version we've seen: the text is byte-identical to
        // that moment, so the chunk states and tracker positions from then are exact.
        // Without this, undoing an accept leaves the chunk looking "still applied" and
        // the mismatch check below would mis-file it as a manual edit.
        this.restore(snapshot);
      } else {
        for (const chunk of this.chunks) {
          if (chunk.state === 'manuallyEdited') {
            continue;
          }
          if (this.actualText(chunk) !== this.expectedText(chunk)) {
            chunk.state = 'manuallyEdited';
          }
        }
        // Record this version too, so undoing *typing* also restores states.
        this.snapshot();
      }
      // Even with no state change the text moved, so the layout must be recomputed.
      this.onChange();
    });
  }

  /** Whether an action is currently offered for this chunk. */
  can(chunk: Chunk, action: ChunkAction): boolean {
    return transition(chunk.kind, chunk.state, action) !== null;
  }

  /**
   * Applies a gutter action: rewrites the chunk's lines in the result and re-pins its
   * tracker. Returns false when the action isn't available.
   */
  apply(chunkId: number, action: Exclude<ChunkAction, 'manualEdit'>): boolean {
    const chunk = this.chunks.find((c) => c.id === chunkId);
    const texts = chunk && this.texts.get(chunkId);
    if (!chunk || !texts) {
      return false;
    }
    const resolution = resolveAction(chunk, texts, action);
    if (!resolution) {
      return false;
    }

    const range = this.centerRange(chunkId);
    const model = this.model;
    this.applying = true;
    try {
      // Undo stops on both sides make each accept its own Cmd+Z step; consecutive
      // executeEdits calls would otherwise coalesce into one opaque undo unit.
      this.editor.pushUndoStop();
      this.editor.executeEdits(EDIT_SOURCE, [
        { range: toMonacoRange(model, range), text: joinLines(resolution.lines) },
      ]);
      this.editor.pushUndoStop();
      chunk.state = resolution.state;
      // Re-pin over exactly the text we just wrote. Stickiness decides how a decoration
      // reacts to edits at its edges, which is not a question with a right answer for a
      // whole-range replacement — so don't ask it.
      this.repin(chunk, range.start, resolution.lines.length);
    } finally {
      this.applying = false;
    }
    this.snapshot();
    this.onChange();
    return true;
  }

  /**
   * Writes arbitrary replacement text into a chunk's region — the AI resolution path.
   *
   * The chunk lands in 'manuallyEdited', exactly as if the user had typed the merge by
   * hand: counted as decided, undoable as its own Cmd+Z step, and nothing reaches git
   * until Apply. Only untouched chunks accept a resolution; anything the user already
   * decided is never overwritten.
   */
  replaceText(chunkId: number, text: string): boolean {
    const chunk = this.chunks.find((c) => c.id === chunkId);
    if (!chunk || chunk.state !== 'initial') {
      return false;
    }
    const range = this.centerRange(chunkId);
    const model = this.model;
    this.applying = true;
    try {
      this.editor.pushUndoStop();
      this.editor.executeEdits(EDIT_SOURCE, [{ range: toMonacoRange(model, range), text }]);
      this.editor.pushUndoStop();
      chunk.state = 'manuallyEdited';
      this.repin(chunk, range.start, text === '' ? 0 : splitLines(text).length);
    } finally {
      this.applying = false;
    }
    this.snapshot();
    this.onChange();
    return true;
  }

  private repin(chunk: Chunk, startLine: number, lineCount: number): void {
    const existing = this.trackers.get(chunk.id);
    const next = this.model.deltaDecorations(existing ? [existing] : [], [
      {
        range: toMonacoRange(this.model, { start: startLine, end: startLine + lineCount }),
        options: { stickiness: STICKINESS },
      },
    ])[0];
    if (next) {
      this.trackers.set(chunk.id, next);
    }
  }

  /** Accepts a side on every chunk the predicate selects, as one undo step. */
  applyMany(pick: (chunk: Chunk) => Exclude<ChunkAction, 'manualEdit'> | null): number {
    let applied = 0;
    // Bottom-up: applying a chunk shifts everything below it, and trackers only settle
    // after the edit. Working upwards keeps every pending range valid.
    for (const chunk of [...this.chunks].reverse()) {
      const action = pick(chunk);
      if (action && this.apply(chunk.id, action)) {
        applied++;
      }
    }
    return applied;
  }

  acceptSide(chunkId: number, side: Side): boolean {
    return this.apply(chunkId, side === 'left' ? 'acceptLeft' : 'acceptRight');
  }

  /**
   * The × on one side of a chunk: "seen it, not taking it."
   *
   * For a conflict this is per-side — the result text never changes, the side just stops
   * offering controls; once every side is applied or dismissed the chunk is settled, and
   * dismissing both from scratch is the classic keep-base ignore. Non-conflict chunks
   * keep the whole-chunk ignore. No text edit happens, so this rides the snapshot at the
   * current text version (overwritten in place) rather than the undo stack.
   */
  dismissSide(chunkId: number, side: Side): boolean {
    const chunk = this.chunks.find((c) => c.id === chunkId);
    if (!chunk) {
      return false;
    }
    if (chunk.kind !== 'conflict') {
      return this.apply(chunkId, 'ignore');
    }
    if (side === 'left') {
      chunk.dismissedLeft = true;
    } else {
      chunk.dismissedRight = true;
    }
    if (chunk.state === 'initial' && chunk.dismissedLeft && chunk.dismissedRight) {
      chunk.state = 'ignored';
    }
    this.snapshot();
    this.onChange();
    return true;
  }

  /**
   * Resolves the whole file to one side in a single step — JetBrains' Accept Left/Right.
   *
   * Chunks the chosen side never touched become 'ignored' (their other-side change was
   * deliberately not taken); everything else is applied. One undo step reverses it all.
   */
  acceptAll(side: Side, fullSideText: string): void {
    this.applying = true;
    try {
      this.editor.pushUndoStop();
      this.editor.executeEdits(EDIT_SOURCE, [
        { range: this.model.getFullModelRange(), text: fullSideText },
      ]);
      this.editor.pushUndoStop();
      for (const chunk of this.chunks) {
        const untouched =
          side === 'left' ? chunk.kind === 'changedRight' : chunk.kind === 'changedLeft';
        chunk.state = untouched
          ? 'ignored'
          : chunk.kind === 'bothIdentical'
            ? 'appliedBoth'
            : side === 'left'
              ? 'appliedLeft'
              : 'appliedRight';
        const range = side === 'left' ? chunk.left : chunk.right;
        this.repin(chunk, range.start, range.end - range.start);
      }
    } finally {
      this.applying = false;
    }
    this.snapshot();
    this.onChange();
  }

  result(): string {
    return this.model.getValue();
  }

  /**
   * Rehydrates a crash-safety snapshot: the saved result text plus every chunk's
   * decision, as one undo step. Same full-document shape as `acceptAll`. Chunks are
   * matched by id — the caller guarantees the snapshot was taken over identical
   * inputs and the same whitespace mode, so ids line up.
   */
  applyWorkSnapshot(snapshot: {
    content: string;
    chunks: ReadonlyArray<{
      id: number;
      state: string;
      dismissedLeft: boolean;
      dismissedRight: boolean;
      start: number;
      end: number;
    }>;
  }): void {
    this.applying = true;
    try {
      this.editor.pushUndoStop();
      this.editor.executeEdits(EDIT_SOURCE, [
        { range: this.model.getFullModelRange(), text: snapshot.content },
      ]);
      this.editor.pushUndoStop();
      for (const saved of snapshot.chunks) {
        const chunk = this.chunks.find((c) => c.id === saved.id);
        if (!chunk) {
          continue;
        }
        chunk.state = saved.state as Chunk['state'];
        chunk.dismissedLeft = saved.dismissedLeft;
        chunk.dismissedRight = saved.dismissedRight;
        this.repin(chunk, saved.start, saved.end - saved.start);
      }
    } finally {
      this.applying = false;
    }
    this.snapshot();
    this.onChange();
  }
}

/** Never let an edit at a chunk's edge silently swallow the neighbouring chunk. */
const STICKINESS: monaco.editor.TrackedRangeStickiness = 1; // NeverGrowsWhenTypingAtEdges

/**
 * Converts between the engine's line space and Monaco's — the one boundary where the two
 * disagree, kept in one place because every off-by-one here corrupts a merge.
 *
 * Engine line `i` is Monaco line `i + 1`, and a half-open range `[s, e)` becomes
 * `(s+1, 1) … (e+1, 1)`: from the start of the first line to the start of the line after
 * the last, so it spans whole lines *including* their newlines. An empty range stays
 * empty, which is what makes an insertion point insert rather than overwrite.
 *
 * The wrinkle is the final line. A document ending in a newline has a phantom empty last
 * line in Monaco (so `e+1` is a real line), but one that doesn't has no line to point at,
 * and `(e+1, 1)` is out of bounds. `validateRange` clamps that to the end of the last
 * line, which covers the same text — `toCenterRange` undoes the clamp on the way back.
 */
function toMonacoRange(model: monaco.editor.ITextModel, range: CenterRange): monaco.IRange {
  return model.validateRange({
    startLineNumber: range.start + 1,
    startColumn: 1,
    endLineNumber: range.end + 1,
    endColumn: 1,
  });
}

function toCenterRange(range: monaco.IRange): CenterRange {
  // A range clamped past the last line ends mid-line rather than at column 1; that still
  // means "through the end of this line", so the exclusive end is the line after it.
  const clamped = range.endColumn > 1;
  return {
    start: range.startLineNumber - 1,
    end: clamped ? range.endLineNumber : range.endLineNumber - 1,
  };
}
