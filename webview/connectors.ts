import type { Chunk } from '../src/merge/chunk';
import type { SideControls } from '../src/merge/resolve';
import type { CenterRange, PixelExtent } from './alignment';
import { rowExtent, visualOf } from './alignment';
import { LINE_HEIGHT, type Panes } from './editors';
import type { monaco } from './monaco';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Which side of the result a strip sits on: the left strip connects left ↔ center. */
export type StripSide = 'left' | 'right';

export interface ConnectorCallbacks {
  onAccept: (chunkId: number, side: StripSide) => void;
  /** The × for one side: per-side dismiss on conflicts, whole-chunk ignore otherwise. */
  onDismiss: (chunkId: number, side: StripSide) => void;
  /** Which controls each side currently offers (see resolve.sideControls). */
  controls: (chunk: Chunk) => SideControls;
  /** Pointer entered/left a chunk's band or controls; undefined clears the hover. */
  onHover: (chunkId: number | undefined) => void;
  /** The ✦ on a conflict: open the per-chunk AI menu anchored at the glyph. */
  onAiMenu: (chunkId: number, anchor: DOMRect) => void;
}

/** Moves a pixel extent into the strip's coordinate space. */
function shift(extent: PixelExtent, by: number): PixelExtent {
  return { top: extent.top + by, bottom: extent.bottom + by };
}

/**
 * Draws the gutter strips between the panes: an S-curved band linking each chunk's rows
 * in the outer pane to its rows in the result (the WebStorm connector shape), plus the
 * chunk's » « × controls at its first line.
 *
 * This is one plain DOM layer we own rather than a set of Monaco widgets. Widgets would
 * fight Monaco's own layout for position, and could not draw the connecting bands at all.
 */
export class Connectors {
  private readonly svg: SVGSVGElement;
  private readonly buttons: HTMLElement;
  /** True while render() is swapping the glyphs, so removal doesn't look like a mouseleave. */
  private rendering = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly side: StripSide,
    private readonly panes: Panes,
    private readonly callbacks: ConnectorCallbacks,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.buttons = document.createElement('div');
    this.buttons.className = 'mf-strip-buttons';
    this.host.append(this.svg, this.buttons);
  }

  /** Pixel offset of an editor line's top from the top of the visible area. */
  private yOf(editor: monaco.editor.IStandaloneCodeEditor, line: number): number {
    return editor.getTopForLineNumber(line + 1) - editor.getScrollTop();
  }

  /**
   * The pixel span a chunk occupies in one pane — its solid block, or its padding
   * zone's span when it has no lines there.
   *
   * The anchor is the whole trick (and where the old misalignment lived): a non-empty
   * block anchors at its first line's top, but an empty side's zone sits *before* its
   * anchor line, so its span starts at the bottom of the *previous* line — which also
   * covers a zone above line 0 (document top) and one after the last line (EOF insert).
   */
  private extentOf(
    editor: monaco.editor.IStandaloneCodeEditor,
    range: { start: number; end: number },
    maxLines: number,
  ): PixelExtent {
    const own = range.end - range.start;
    const anchor =
      own > 0
        ? this.yOf(editor, range.start)
        : range.start > 0
          ? this.yOf(editor, range.start - 1) + LINE_HEIGHT
          : -editor.getScrollTop();
    return rowExtent(own, maxLines, anchor, LINE_HEIGHT);
  }

  /**
   * Vertical distance from the strip's drawing surface to an editor's content origin.
   *
   * Editor y-coordinates start below the pane *header*, while the strip spans the whole
   * pane row — comparing rects against the SVG surface (the merge-studio "stage"
   * technique) makes the geometry page-true regardless of DOM nesting, fonts, or zoom.
   * Skipping this is exactly the ~25px systematic offset the screenshots showed.
   */
  private editorOffset(editor: monaco.editor.IStandaloneCodeEditor): number {
    const dom = editor.getDomNode();
    if (!dom) {
      return 0;
    }
    return dom.getBoundingClientRect().top - this.svg.getBoundingClientRect().top;
  }

  render(
    chunks: readonly Chunk[],
    centerRanges: ReadonlyMap<number, CenterRange>,
    emphasis?: {
      currentChunkId?: number | undefined;
      flashChunkId?: number | undefined;
      hoverChunkId?: number | undefined;
    },
  ): void {
    const outer = this.panes[this.side];
    const center = this.panes.center;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const outerShift = this.editorOffset(outer);
    const centerShift = this.editorOffset(center);

    const shapes: SVGElement[] = [];
    const controls: HTMLElement[] = [];
    this.rendering = true;
    try {
      for (const chunk of chunks) {
        const outerRange = this.side === 'left' ? chunk.left : chunk.right;
        const centerRange = centerRanges.get(chunk.id);
        if (!centerRange) {
          continue;
        }
        // Nothing marks this chunk on this side, so there is nothing to connect.
        if (outerRange.start === outerRange.end && centerRange.start === centerRange.end) {
          continue;
        }

        // Padding goes to the tallest of all three panes — extents must use the same max.
        const maxLines = Math.max(
          chunk.left.end - chunk.left.start,
          centerRange.end - centerRange.start,
          chunk.right.end - chunk.right.start,
        );
        const outerExtent = shift(this.extentOf(outer, outerRange, maxLines), outerShift);
        const centerExtent = shift(this.extentOf(center, centerRange, maxLines), centerShift);

        if (
          Math.max(outerExtent.bottom, centerExtent.bottom) < 0 ||
          Math.min(outerExtent.top, centerExtent.top) > height
        ) {
          continue; // fully scrolled out of view
        }

        const band = this.band(chunk, width, outerExtent, centerExtent);
        if (chunk.id === emphasis?.currentChunkId) {
          band.classList.add('mf-band-current');
        }
        if (chunk.id === emphasis?.flashChunkId) {
          band.classList.add('mf-band-flash');
        }
        if (chunk.id === emphasis?.hoverChunkId) {
          band.classList.add('mf-band-hover');
        }
        shapes.push(band);
        controls.push(...this.controlsFor(chunk, outerExtent.top));
      }

      this.svg.replaceChildren(...shapes);
      this.buttons.replaceChildren(...controls);
    } finally {
      this.rendering = false;
    }
  }

  /** Hover emphasis only. Rebuilding the buttons here drops the click that was about to land. */
  setHover(chunkId: number | undefined): void {
    const mark = chunkId === undefined ? '' : String(chunkId);
    for (const node of this.svg.querySelectorAll<SVGElement>('.mf-band')) {
      node.classList.toggle('mf-band-hover', node.dataset.chunkId === mark);
    }
  }

  /**
   * The WebStorm/merge-studio ribbon: a flat rectangular shelf hugging the outer pane
   * for the button zone — the »/× glyphs sit *on* the colour — then a smooth
   * horizontal-tangent bend across the remaining width to the result's extent.
   * Equal extents degenerate into a clean flush rectangle, which is the correct
   * rendering for rows our alignment already made pixel-equal.
   */
  private band(chunk: Chunk, width: number, outer: PixelExtent, center: PixelExtent): SVGElement {
    const [xOuter, xCenter] = this.side === 'left' ? [0, width] : [width, 0];
    // Shelf covers the button zone; the bend gets the rest of the strip.
    const xShelf = xOuter + (xCenter - xOuter) * 0.55;
    const midBend = (xShelf + xCenter) / 2;
    // Degenerate spans keep a visible edge to point at.
    const oBottom = Math.max(outer.bottom, outer.top + 1.5);
    const cBottom = Math.max(center.bottom, center.top + 1.5);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      `M ${xOuter} ${outer.top} ` +
        `L ${xShelf} ${outer.top} ` +
        `C ${midBend} ${outer.top} ${midBend} ${center.top} ${xCenter} ${center.top} ` +
        `L ${xCenter} ${cBottom} ` +
        `C ${midBend} ${cBottom} ${midBend} ${oBottom} ${xShelf} ${oBottom} ` +
        `L ${xOuter} ${oBottom} Z`,
    );
    // Colours live in CSS (.mf-band-<family>) so the light theme can override them.
    path.classList.add('mf-band', `mf-band-${visualOf(chunk)}`);
    path.dataset.chunkId = String(chunk.id);
    if (chunk.state !== 'initial') {
      path.setAttribute('opacity', '0.3');
    }
    path.style.pointerEvents = 'auto';
    path.addEventListener('mouseenter', () => this.hover(chunk.id));
    path.addEventListener('mouseleave', (event) => this.leave(event));
    return path;
  }

  private controlsFor(chunk: Chunk, top: number): HTMLElement[] {
    const row = document.createElement('div');
    row.className = `mf-chunk-controls mf-controls-${this.side}`;
    // Sit the pair on the band's shelf at the chunk's first row, WebStorm-style.
    row.style.top = `${Math.max(0, top + 1)}px`;

    row.addEventListener('mouseenter', () => this.hover(chunk.id));
    row.addEventListener('mouseleave', (event) => this.leave(event));
    const offered = this.callbacks.controls(chunk);
    const showAccept = this.side === 'left' ? offered.acceptLeft : offered.acceptRight;
    const showIgnore = this.side === 'left' ? offered.ignoreLeft : offered.ignoreRight;

    // The chevron pushes/pulls that side into the result; Alt+arrow does the same for
    // the current chunk.
    const accept = showAccept
      ? this.glyph(
          this.side === 'left' ? 'chevron-right' : 'chevron-left',
          `Accept this change (Alt+${this.side === 'left' ? '←' : '→'})`,
          () => this.callbacks.onAccept(chunk.id, this.side),
        )
      : null;
    const ignore = showIgnore
      ? this.glyph('close', 'Ignore this change', () =>
          this.callbacks.onDismiss(chunk.id, this.side),
        )
      : null;

    // Per-chunk AI entry point — left strip only, so the pair isn't duplicated.
    const sparkle =
      this.side === 'left' && chunk.kind === 'conflict' && chunk.state === 'initial'
        ? this.glyph('sparkle', 'AI: explain or resolve this conflict', (event) => {
            const target = event.currentTarget as HTMLElement;
            this.callbacks.onAiMenu(chunk.id, target.getBoundingClientRect());
          })
        : null;

    // The arrow always sits on the *inner* side (toward the result), × on the outer:
    // left strip reads "× »", right strip reads "« ×" — matching WebStorm.
    const ordered = this.side === 'left' ? [ignore, accept, sparkle] : [accept, ignore];
    row.append(...ordered.filter((glyph): glyph is HTMLElement => glyph !== null));
    return row.childElementCount > 0 ? [row] : [];
  }

  private glyph(codicon: string, title: string, onClick: (event: MouseEvent) => void): HTMLElement {
    const button = document.createElement('button');
    button.className = 'mf-chunk-glyph';
    button.title = title;
    button.setAttribute('aria-label', title);
    const icon = document.createElement('span');
    icon.className = `codicon codicon-${codicon}`;
    button.append(icon);
    // pointerdown, not click: WebKit drops click when the button is replaced between
    // mousedown and mouseup, which is exactly how a hover repaint used to eat the accept.
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
    return button;
  }

  private hover(chunkId: number): void {
    if (this.rendering) {
      return;
    }
    this.callbacks.onHover(chunkId);
  }

  private leave(event: MouseEvent): void {
    if (this.rendering) {
      return;
    }
    const next = event.relatedTarget;
    if (next instanceof Node && this.host.contains(next)) {
      return;
    }
    this.callbacks.onHover(undefined);
  }
}
