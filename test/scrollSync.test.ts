import { describe, expect, test } from 'vitest';
import type { PaneName } from '../webview/panes';
import { syncScrolling, type ScrollEvent, type ScrollableEditor } from '../webview/scrollSync';

/**
 * A stand-in editor that behaves like Monaco's in the way that matters here: setting the
 * scroll position fires a scroll event. That feedback is exactly what the guard defends
 * against, so the fake has to reproduce it or the test proves nothing.
 */
class FakeEditor implements ScrollableEditor {
  private top = 0;
  private left = 0;
  private listeners: Array<(event: ScrollEvent) => void> = [];
  setTopCalls = 0;

  onDidScrollChange(listener: (event: ScrollEvent) => void) {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }

  getScrollTop() {
    return this.top;
  }

  getScrollLeft() {
    return this.left;
  }

  setScrollTop(value: number) {
    this.setTopCalls++;
    if (this.top === value) {
      return;
    }
    this.top = value;
    this.emit({
      scrollTop: value,
      scrollLeft: this.left,
      scrollTopChanged: true,
      scrollLeftChanged: false,
    });
  }

  setScrollLeft(value: number) {
    if (this.left === value) {
      return;
    }
    this.left = value;
    this.emit({
      scrollTop: this.top,
      scrollLeft: value,
      scrollTopChanged: false,
      scrollLeftChanged: true,
    });
  }

  private emit(event: ScrollEvent) {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

function makePanes(): Record<PaneName, FakeEditor> {
  return { left: new FakeEditor(), center: new FakeEditor(), right: new FakeEditor() };
}

describe('syncScrolling', () => {
  test('scrolling one pane scrolls the other two to the same position', () => {
    const panes = makePanes();
    syncScrolling(panes);
    panes.left.setScrollTop(120);
    expect(panes.center.getScrollTop()).toBe(120);
    expect(panes.right.getScrollTop()).toBe(120);
  });

  test('mirrors horizontal scrolling too', () => {
    const panes = makePanes();
    syncScrolling(panes);
    panes.right.setScrollLeft(45);
    expect(panes.left.getScrollLeft()).toBe(45);
    expect(panes.center.getScrollLeft()).toBe(45);
  });

  test('does not echo: a synced pane does not scroll the others back', () => {
    const panes = makePanes();
    syncScrolling(panes);
    panes.center.setScrollTop(80);
    // Each other pane is written exactly once — an echo would re-enter and write again.
    expect(panes.left.setTopCalls).toBe(1);
    expect(panes.right.setTopCalls).toBe(1);
  });

  test('scrolling from every pane works, not just the first', () => {
    for (const source of ['left', 'center', 'right'] as const) {
      const panes = makePanes();
      syncScrolling(panes);
      panes[source].setScrollTop(200);
      for (const name of ['left', 'center', 'right'] as const) {
        expect(panes[name].getScrollTop()).toBe(200);
      }
    }
  });

  test('reports scroll so dependent overlays can redraw', () => {
    const panes = makePanes();
    let redraws = 0;
    syncScrolling(panes, () => {
      redraws++;
    });
    panes.left.setScrollTop(10);
    expect(redraws).toBe(1);
  });

  test('disposing stops the mirroring', () => {
    const panes = makePanes();
    for (const d of syncScrolling(panes)) {
      d.dispose();
    }
    panes.left.setScrollTop(60);
    expect(panes.center.getScrollTop()).toBe(0);
  });
});
