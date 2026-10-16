import { PANE_NAMES, type PaneName } from './panes';

/**
 * Scroll mirroring across the three panes.
 *
 * Typed against the minimum an editor must provide rather than Monaco itself, so the
 * echo-guard logic — the part that can loop forever or fight the user's scroll — is
 * testable without a browser. Monaco's editors satisfy this shape structurally.
 */

export interface ScrollEvent {
  scrollTop: number;
  scrollLeft: number;
  scrollTopChanged: boolean;
  scrollLeftChanged: boolean;
}

export interface Disposable {
  dispose(): void;
}

export interface ScrollableEditor {
  onDidScrollChange(listener: (event: ScrollEvent) => void): Disposable;
  getScrollTop(): number;
  setScrollTop(value: number): void;
  getScrollLeft(): number;
  setScrollLeft(value: number): void;
}

/**
 * Keeps the panes scrolled together.
 *
 * View-zone alignment makes all three the same height, so positions map 1:1 with no
 * interpolation. The `syncing` guard is what stops the echo: setting scroll on the other
 * panes fires their own scroll events, which would bounce straight back here.
 */
export function syncScrolling(
  panes: Record<PaneName, ScrollableEditor>,
  onScroll: () => void = () => {},
): Disposable[] {
  let syncing = false;
  return PANE_NAMES.map((source) =>
    panes[source].onDidScrollChange((event) => {
      if (syncing) {
        return;
      }
      syncing = true;
      try {
        for (const target of PANE_NAMES) {
          if (target === source) {
            continue;
          }
          const editor = panes[target];
          // Skip no-op writes: they would still fire a scroll event on the target.
          if (event.scrollTopChanged && editor.getScrollTop() !== event.scrollTop) {
            editor.setScrollTop(event.scrollTop);
          }
          if (event.scrollLeftChanged && editor.getScrollLeft() !== event.scrollLeft) {
            editor.setScrollLeft(event.scrollLeft);
          }
        }
      } finally {
        syncing = false;
      }
      onScroll();
    }),
  );
}
