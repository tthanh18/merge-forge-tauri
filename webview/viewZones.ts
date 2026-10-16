import type { Spacer } from './alignment';
import type { Panes } from './editors';
import { PANE_NAMES, type PaneName } from './panes';

/** Monaco glue for alignment: turns spacers into view zones. */

export type ZoneIds = Record<PaneName, string[]>;

export function emptyZoneIds(): ZoneIds {
  return { left: [], center: [], right: [] };
}

/**
 * Replaces every spacer zone in one batched layout per pane.
 *
 * Zones are rebuilt wholesale rather than diffed: `changeViewZones` already batches into
 * a single layout pass, and tracking zone identity across edits buys little at these
 * sizes while being a steady source of drift.
 */
export function applySpacers(
  panes: Panes,
  spacers: Record<PaneName, Spacer[]>,
  zoneIds: ZoneIds,
): void {
  for (const name of PANE_NAMES) {
    panes[name].changeViewZones((accessor) => {
      for (const id of zoneIds[name]) {
        accessor.removeZone(id);
      }
      zoneIds[name] = spacers[name].map((spacer) => {
        // A tinted node makes the padding read as "this chunk's absent lines" rather
        // than a broken void — the WebStorm treatment for alignment gaps.
        const domNode = document.createElement('div');
        domNode.className = spacer.visual ? `mf-zone mf-zone-${spacer.visual}` : 'mf-zone';
        return accessor.addZone({
          // Monaco anchors after a 1-based line; 0 means "above the first line".
          afterLineNumber: spacer.afterLine,
          heightInLines: spacer.heightInLines,
          domNode,
        });
      });
    });
  }
}
