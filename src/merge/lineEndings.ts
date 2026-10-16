import type { Eol, EolInfo } from '../protocol';

/** How the result's line ending is chosen when the sides disagree. */
export type EolSetting = 'auto' | 'lf' | 'crlf';

/**
 * Returns the dominant line ending of `text`. Text with no line breaks is 'lf',
 * which keeps single-line files stable rather than guessing from nothing.
 */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      if (i > 0 && text[i - 1] === '\r') {
        crlf++;
      } else {
        lf++;
      }
    }
  }
  return crlf > lf ? 'crlf' : 'lf';
}

/** Converts all CRLF to LF. Every diff in this codebase runs on normalized text. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Re-applies `eol` to LF-normalized text. Inverse of {@link normalizeEol}. */
export function applyEol(text: string, eol: Eol): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * Compares the line endings of the three versions and picks the result's EOL.
 * With 'auto', your local side wins — matching what you'd get by keeping your file.
 */
export function makeEolInfo(
  left: string,
  base: string,
  right: string,
  setting: EolSetting,
): EolInfo {
  const leftEol = detectEol(left);
  const baseEol = detectEol(base);
  const rightEol = detectEol(right);
  return {
    left: leftEol,
    base: baseEol,
    right: rightEol,
    conflict: !(leftEol === baseEol && baseEol === rightEol),
    suggested: setting === 'auto' ? leftEol : setting,
  };
}
