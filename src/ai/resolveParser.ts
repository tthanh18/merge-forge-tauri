/**
 * Parses the delimiter protocol the resolve prompt asks for:
 *
 *   <<<RESOLVED n>>>
 *   <merged code>
 *   <<<END n>>>
 *
 * Delimiters (not JSON mode) because every backend — including the editor's own
 * Language Model API — can emit plain text reliably. Parsing is deliberately
 * forgiving about surroundings and strict about structure: commentary outside
 * blocks is ignored, a block only counts when its END index matches, and anything
 * unparseable simply yields no entry so the conflict stays open for the human.
 */

const BLOCK = /<<<RESOLVED (\d+)>>>\r?\n?([\s\S]*?)\r?\n?<<<END \1>>>/g;

/** Strips one markdown fence wrapping the whole block, a common model reflex. */
function unfence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return match?.[1] !== undefined ? match[1] : text;
}

/**
 * Extracts resolutions for the expected conflict indexes. Values are normalized to
 * end with a newline; an intentionally empty resolution (delete the region) stays ''.
 */
export function parseResolutions(text: string, expected: readonly number[]): Map<number, string> {
  const wanted = new Set(expected);
  const result = new Map<number, string>();
  for (const match of text.matchAll(BLOCK)) {
    const index = Number(match[1]);
    if (!wanted.has(index)) {
      continue;
    }
    const body = unfence(match[2] ?? '');
    result.set(index, body === '' ? '' : body.endsWith('\n') ? body : `${body}\n`);
  }
  return result;
}
