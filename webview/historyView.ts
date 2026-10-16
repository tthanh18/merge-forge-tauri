/**
 * The history timeline: a chronological two-lane view of the commits that produced
 * this merge — yours on the left, theirs on the right, newest first, merge base at
 * the bottom. Swaps in for the three panes via the toolbar's history toggle; the
 * editors stay mounted (and keep all state) underneath.
 */

import type { AuthorInfo, HistoryPayload } from '../src/protocol';
import { chipContent, relativeDate } from './authorChips';

export interface HistoryView {
  show(data: HistoryPayload): void;
  hide(): void;
  readonly isOpen: boolean;
}

export function createHistoryView(
  host: HTMLElement,
  onOpenAuthor: (author: AuthorInfo, anchor: DOMRect) => void,
): HistoryView {
  host.classList.add('mf-history', 'mf-hidden');

  const render = (data: HistoryPayload): void => {
    host.replaceChildren();

    const header = document.createElement('div');
    header.className = 'mf-history-header';
    const yours = document.createElement('span');
    yours.className = 'mf-history-branch mf-history-branch-yours';
    yours.textContent = `● ${data.branches.yours} (yours)`;
    const theirs = document.createElement('span');
    theirs.className = 'mf-history-branch mf-history-branch-theirs';
    theirs.textContent = `(theirs) ${data.branches.theirs} ●`;
    header.append(yours, theirs);
    host.append(header);

    const list = document.createElement('div');
    list.className = 'mf-history-list';
    if (data.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'mf-history-empty';
      empty.textContent =
        'No commits touching this file were found on either branch since the merge base.';
      list.append(empty);
    }
    for (const entry of data.entries) {
      const row = document.createElement('button');
      row.className = `mf-history-row mf-history-${entry.lane}`;
      const chip = document.createElement('span');
      chip.className = 'mf-author-chip mf-author-chip-static';
      chip.append(chipContent(entry));
      const text = document.createElement('span');
      text.className = 'mf-history-text';
      const subject = document.createElement('span');
      subject.className = 'mf-history-subject';
      subject.textContent = entry.subject;
      const meta = document.createElement('span');
      meta.className = 'mf-history-meta';
      meta.textContent = `${entry.name} · ${relativeDate(entry.timestamp)}`;
      text.append(subject, meta);
      row.append(chip, text);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        onOpenAuthor(entry, (event.currentTarget as HTMLElement).getBoundingClientRect());
      });
      list.append(row);
    }
    host.append(list);

    if (data.mergeBase) {
      const base = document.createElement('div');
      base.className = 'mf-history-base';
      base.textContent = `merge base · ${data.mergeBase.sha.slice(0, 8)} · ${relativeDate(
        data.mergeBase.timestamp,
      )}`;
      host.append(base);
    }
  };

  return {
    get isOpen() {
      return !host.classList.contains('mf-hidden');
    },
    show(data) {
      render(data);
      host.classList.remove('mf-hidden');
    },
    hide() {
      host.classList.add('mf-hidden');
    },
  };
}
