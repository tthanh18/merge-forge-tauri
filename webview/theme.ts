import { monaco } from './monaco';

export const THEME_NAME = 'merge-forge';

function cssVar(name: string): string | undefined {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value === '' ? undefined : value;
}

/** Rough perceived brightness of a #rrggbb colour, used to pick a base theme. */
function isDark(color: string | undefined): boolean {
  const match = /^#([0-9a-f]{6})/i.exec(color ?? '');
  if (!match?.[1]) {
    return true;
  }
  const value = Number.parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/** Only pass colours Monaco can parse; a bad value throws and takes the editor with it. */
function colors(entries: Array<[string, string | undefined]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Builds a Monaco theme from the webview's `--vscode-*` variables so the panes match the
 * surrounding editor chrome.
 *
 * Token colours can't follow: a webview is only given VS Code's UI colours, not the
 * active TextMate theme, so syntax highlighting comes from Monaco's own `vs`/`vs-dark`
 * defaults picked by background luminance. Close, but not identical to the real editor.
 */
export function applyTheme(): void {
  const background = cssVar('--vscode-editor-background');
  const dark = isDark(background);
  // The chunk palette is tuned per theme in CSS; this class is the switch.
  document.body.classList.toggle('mf-light', !dark);
  monaco.editor.defineTheme(THEME_NAME, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: colors([
      ['editor.background', background],
      ['editor.foreground', cssVar('--vscode-editor-foreground')],
      ['editorLineNumber.foreground', cssVar('--vscode-editorLineNumber-foreground')],
      ['editorLineNumber.activeForeground', cssVar('--vscode-editorLineNumber-activeForeground')],
      ['editor.selectionBackground', cssVar('--vscode-editor-selectionBackground')],
      ['editorCursor.foreground', cssVar('--vscode-editorCursor-foreground')],
      ['editorIndentGuide.background', cssVar('--vscode-editorIndentGuide-background')],
      ['editorWidget.background', cssVar('--vscode-editorWidget-background')],
    ]),
  });
  monaco.editor.setTheme(THEME_NAME);
}

/** Re-applies the theme when the user switches between light and dark. */
export function watchTheme(): void {
  new MutationObserver(() => applyTheme()).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-vscode-theme-kind', 'data-vscode-theme-id'],
  });
}
