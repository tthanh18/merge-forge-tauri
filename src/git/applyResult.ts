import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Eol } from '../protocol';
import { applyEol } from '../merge/lineEndings';
import { markResolved } from './conflicts';

/** UTF-8 byte-order mark, preserved so applying a merge never silently strips one. */
const BOM = '﻿';

/**
 * Restores the on-disk form of the merged text.
 *
 * The webview works in LF throughout so diffing is line-ending agnostic; this puts back
 * the EOL the user chose, and re-attaches a BOM if the file had one.
 */
export function encodeResult(content: string, eol: Eol, hadBom: boolean): Buffer {
  const withoutBom = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  const text = applyEol(withoutBom, eol);
  return Buffer.from(hadBom ? BOM + text : text, 'utf8');
}

/**
 * Writes the resolved file and stages it, which is how git records a conflict as settled.
 * Writing and staging are one step on purpose: a written-but-unstaged file still shows as
 * conflicted, which is a confusing half-done state to leave someone in.
 */
export async function applyResolved(
  repoRoot: string,
  relativePath: string,
  content: string,
  eol: Eol,
  hadBom: boolean,
): Promise<void> {
  await writeFile(join(repoRoot, relativePath), encodeResult(content, eol, hadBom));
  await markResolved(repoRoot, relativePath);
}
