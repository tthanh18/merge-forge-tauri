import { describe, expect, it } from 'vitest';
import { checkSyntax } from '../webview/lint';

describe('checkSyntax', () => {
  it('accepts valid TypeScript and JSX', () => {
    expect(checkSyntax('typescript', 'src/value.ts', 'const value: number = 1;\n')).toEqual([]);
    expect(
      checkSyntax('typescriptreact', 'src/View.tsx', 'export const View = () => <div />;\n'),
    ).toEqual([]);
  });

  it('reports TypeScript syntax errors at their source position', () => {
    const issues = checkSyntax('typescript', 'src/value.ts', 'const value = ;\n');

    expect(issues).not.toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues?.[0]).toMatchObject({
      startLine: 0,
      message: expect.stringContaining('Expression expected'),
    });
  });

  it('checks JavaScript based on the file extension', () => {
    const issues = checkSyntax('plaintext', 'script.mjs', 'export const value = ;\n');

    expect(issues).not.toBeNull();
    expect(issues?.length).toBeGreaterThan(0);
  });

  it('reports invalid JSON and accepts valid JSON', () => {
    expect(checkSyntax('json', 'data.json', '{"ok": true}')).toEqual([]);
    expect(checkSyntax('json', 'data.json', '{"ok": }')).toHaveLength(1);
  });

  it('returns null when no syntax checker is available', () => {
    expect(checkSyntax('python', 'main.py', 'print("ok")')).toBeNull();
  });
});
