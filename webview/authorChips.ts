/**
 * Authorship chips: one small avatar per conflict side, sitting in the side panes'
 * glyph-margin lane at the chunk's first line — "this side was last shaped by X".
 * Rendering follows the Connectors pattern: a DOM overlay we own, repositioned on
 * every redraw (scroll, refresh, resize), rather than Monaco widgets.
 */

import type { Chunk } from '../src/merge/chunk';
import type { AuthorInfo } from '../src/protocol';
import { LINE_HEIGHT, type Panes } from './editors';

export interface ChunkAuthors {
  left?: AuthorInfo;
  right?: AuthorInfo;
}

/** "3 days ago" — coarse on purpose; the popover carries the precise data. */
export function relativeDate(timestampSeconds: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - timestampSeconds);
  const steps: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let value = seconds;
  let unit = 'second';
  for (const [size, name] of steps) {
    unit = name;
    if (value < size) {
      break;
    }
    value = Math.floor(value / size);
  }
  const count = Math.max(1, Math.floor(value));
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/** The chip's inner content: the avatar image when we have one, initials otherwise. */
export function chipContent(author: AuthorInfo): HTMLElement {
  const initials = document.createElement('span');
  initials.className = 'mf-author-initials';
  initials.style.background = author.color;
  initials.textContent = author.initials;
  if (!author.avatarUrl) {
    return initials;
  }
  const img = document.createElement('img');
  img.className = 'mf-author-img';
  img.src = author.avatarUrl;
  img.alt = author.initials;
  // A 404 (deleted account, offline) falls back to the initials circle in place.
  img.addEventListener('error', () => img.replaceWith(initials));
  return img;
}

export class AuthorChips {
  private readonly layers: { left: HTMLElement; right: HTMLElement };
  private data = new Map<number, ChunkAuthors>();

  constructor(
    hosts: { left: HTMLElement; right: HTMLElement },
    private readonly panes: Panes,
    private readonly onOpen: (author: AuthorInfo, anchor: DOMRect) => void,
  ) {
    this.layers = {
      left: document.createElement('div'),
      right: document.createElement('div'),
    };
    for (const side of ['left', 'right'] as const) {
      this.layers[side].className = 'mf-author-layer';
      hosts[side].append(this.layers[side]);
    }
  }

  setData(entries: Array<{ chunkId: number } & ChunkAuthors>): void {
    this.data = new Map(entries.map(({ chunkId, ...authors }) => [chunkId, authors]));
  }

  get hasData(): boolean {
    return this.data.size > 0;
  }

  render(chunks: readonly Chunk[]): void {
    for (const side of ['left', 'right'] as const) {
      const editor = this.panes[side];
      const height = this.layers[side].clientHeight;
      const chips: HTMLElement[] = [];
      for (const chunk of chunks) {
        const author = this.data.get(chunk.id)?.[side];
        const range = side === 'left' ? chunk.left : chunk.right;
        if (!author || range.end <= range.start) {
          continue;
        }
        const top = editor.getTopForLineNumber(range.start + 1) - editor.getScrollTop();
        if (top < -LINE_HEIGHT || top > height + LINE_HEIGHT) {
          continue;
        }
        chips.push(this.chip(author, top));
      }
      this.layers[side].replaceChildren(...chips);
    }
  }

  private chip(author: AuthorInfo, top: number): HTMLElement {
    const button = document.createElement('button');
    button.className = 'mf-author-chip';
    button.style.top = `${top + 1}px`;
    button.title = `${author.name} · ${author.subject}`;
    button.setAttribute('aria-label', `Last changed by ${author.name}`);
    button.append(chipContent(author));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.onOpen(author, (event.currentTarget as HTMLElement).getBoundingClientRect());
    });
    return button;
  }
}
