/** Pane identity, kept free of Monaco so the pure layout math stays testable in Node. */

export type PaneName = 'left' | 'center' | 'right';

export const PANE_NAMES: readonly PaneName[] = ['left', 'center', 'right'];
