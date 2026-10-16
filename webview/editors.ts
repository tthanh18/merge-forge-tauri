import { monaco } from './monaco';
import { PANE_NAMES, type PaneName } from './panes';
import { THEME_NAME } from './theme';

export type Panes = Record<PaneName, monaco.editor.IStandaloneCodeEditor>;

/**
 * One fixed line height across all panes. Alignment and connector geometry both convert
 * line counts to pixels with this — it must match `paneOptions` exactly.
 */
/**
 * Line height in px — the unit all strip/chip geometry is computed in. Mutable
 * (ESM live binding) because it scales with the user's editor font size; set
 * once in `createPanes` before any geometry is drawn.
 */
export let LINE_HEIGHT = 18;

/** The user's editor font, forwarded from the host so panes match their editor. */
export interface PaneFont {
  size: number;
  family: string;
  ligatures: boolean;
}

/**
 * Options shared by all three panes.
 *
 * The alignment strategy pads panes with view zones so equal content occupies equal
 * vertical space; that only holds if every pane agrees on line height. Word wrap and
 * folding would break the line↔pixel correspondence, so both stay off.
 */
function paneOptions(
  readOnly: boolean,
  font?: PaneFont,
): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    theme: THEME_NAME,
    readOnly,
    // Read-only panes shouldn't show a blinking cursor pretending they're editable.
    ...(readOnly ? { cursorBlinking: 'solid' as const, renderLineHighlight: 'none' as const } : {}),
    automaticLayout: true,
    wordWrap: 'off',
    folding: false,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    lineNumbersMinChars: 3,
    // Side panes reserve the glyph lane for the authorship chips; the editable
    // result keeps its full width.
    glyphMargin: readOnly,
    // Chunk decorations paint scrollbar marks (WebStorm's right-edge stripes).
    overviewRulerLanes: 2,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: {
      // Only the center pane shows a vertical scrollbar; all three scroll together.
      vertical: readOnly ? 'hidden' : 'auto',
      horizontal: 'auto',
      handleMouseWheel: true,
    },
    fontSize: font?.size ?? 12,
    ...(font?.family ? { fontFamily: font.family } : {}),
    fontLigatures: font?.ligatures ?? false,
    lineHeight: LINE_HEIGHT,
  };
}

/** Creates the three editors and their models. Left and right are read-only, as in JetBrains. */
export function createPanes(
  hosts: Record<PaneName, HTMLElement>,
  content: Record<PaneName, string>,
  languageId: string,
  font?: PaneFont,
): Panes {
  // All strip/chip geometry derives from LINE_HEIGHT — scale it with the font
  // before any editor exists so every consumer sees one consistent value.
  if (font) {
    LINE_HEIGHT = Math.max(16, Math.round(font.size * 1.5));
  }
  const make = (name: PaneName): monaco.editor.IStandaloneCodeEditor =>
    monaco.editor.create(hosts[name], {
      ...paneOptions(name !== 'center', font),
      model: monaco.editor.createModel(content[name], languageId),
    });
  return { left: make('left'), center: make('center'), right: make('right') };
}

export function disposePanes(panes: Panes): void {
  for (const name of PANE_NAMES) {
    panes[name].getModel()?.dispose();
    panes[name].dispose();
  }
}
