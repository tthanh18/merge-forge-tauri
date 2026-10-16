import { describe, expect, test } from 'vitest';
import { applyEol, detectEol, makeEolInfo, normalizeEol } from '../src/merge/lineEndings';

describe('detectEol', () => {
  test('detects lf', () => {
    expect(detectEol('a\nb\nc\n')).toBe('lf');
  });

  test('detects crlf', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('crlf');
  });

  test('detects dominant eol in mixed content', () => {
    expect(detectEol('a\r\nb\nc\nd\n')).toBe('lf');
    expect(detectEol('a\r\nb\r\nc\n')).toBe('crlf');
  });

  test('defaults to lf when there are no line breaks', () => {
    expect(detectEol('single line')).toBe('lf');
  });
});

describe('normalizeEol', () => {
  test('converts crlf to lf', () => {
    expect(normalizeEol('a\r\nb\r\n')).toBe('a\nb\n');
  });

  test('leaves lf untouched', () => {
    expect(normalizeEol('a\nb\n')).toBe('a\nb\n');
  });
});

describe('applyEol', () => {
  test('applies crlf', () => {
    expect(applyEol('a\nb\n', 'crlf')).toBe('a\r\nb\r\n');
  });

  test('applies lf (no-op on normalized text)', () => {
    expect(applyEol('a\nb\n', 'lf')).toBe('a\nb\n');
  });

  test('round-trips: applyEol(normalizeEol(x)) preserves crlf text', () => {
    const original = 'a\r\nb\r\nc';
    expect(applyEol(normalizeEol(original), 'crlf')).toBe(original);
  });
});

describe('makeEolInfo', () => {
  test('no conflict when all sides agree', () => {
    const info = makeEolInfo('a\nb', 'a\n', 'a\nc', 'auto');
    expect(info.conflict).toBe(false);
    expect(info.suggested).toBe('lf');
  });

  test('conflict when sides disagree, auto suggests the left side', () => {
    const info = makeEolInfo('a\r\nb\r\n', 'a\n', 'a\nc\n', 'auto');
    expect(info.conflict).toBe(true);
    expect(info.suggested).toBe('crlf');
  });

  test('explicit setting overrides auto suggestion', () => {
    const info = makeEolInfo('a\r\nb\r\n', 'a\n', 'a\nc\n', 'lf');
    expect(info.conflict).toBe(true);
    expect(info.suggested).toBe('lf');
  });
});
