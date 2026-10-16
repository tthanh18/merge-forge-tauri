import { describe, expect, test } from 'vitest';
import { isResolved, transition } from '../src/merge/chunk';

describe('transition', () => {
  test('accepting the changed side resolves a one-sided chunk', () => {
    expect(transition('changedLeft', 'initial', 'acceptLeft')).toBe('appliedLeft');
    expect(transition('changedRight', 'initial', 'acceptRight')).toBe('appliedRight');
  });

  test('accepting the unchanged side of a one-sided chunk is invalid', () => {
    expect(transition('changedLeft', 'initial', 'acceptRight')).toBeNull();
    expect(transition('changedRight', 'initial', 'acceptLeft')).toBeNull();
  });

  test('a conflict accepts either side first', () => {
    expect(transition('conflict', 'initial', 'acceptLeft')).toBe('appliedLeft');
    expect(transition('conflict', 'initial', 'acceptRight')).toBe('appliedRight');
  });

  test('a conflict can accept both sides in click order', () => {
    expect(transition('conflict', 'appliedLeft', 'acceptRight')).toBe('appliedBoth');
    expect(transition('conflict', 'appliedRight', 'acceptLeft')).toBe('appliedBoth');
  });

  test('a one-sided chunk cannot be accepted twice', () => {
    expect(transition('changedLeft', 'appliedLeft', 'acceptLeft')).toBeNull();
  });

  test('bothIdentical resolves with a single accept from either side', () => {
    expect(transition('bothIdentical', 'initial', 'acceptLeft')).toBe('appliedBoth');
    expect(transition('bothIdentical', 'initial', 'acceptRight')).toBe('appliedBoth');
  });

  test('ignore is only valid from initial', () => {
    expect(transition('conflict', 'initial', 'ignore')).toBe('ignored');
    expect(transition('conflict', 'appliedLeft', 'ignore')).toBeNull();
    expect(transition('conflict', 'ignored', 'ignore')).toBeNull();
  });

  test('manual edits mark any state as manuallyEdited', () => {
    expect(transition('conflict', 'initial', 'manualEdit')).toBe('manuallyEdited');
    expect(transition('changedLeft', 'appliedLeft', 'manualEdit')).toBe('manuallyEdited');
    expect(transition('conflict', 'ignored', 'manualEdit')).toBe('manuallyEdited');
  });

  test('accepting after a manual edit re-applies the side', () => {
    expect(transition('conflict', 'manuallyEdited', 'acceptLeft')).toBe('appliedLeft');
  });

  test('revert restores any non-initial state to initial', () => {
    expect(transition('conflict', 'ignored', 'revert')).toBe('initial');
    expect(transition('conflict', 'appliedBoth', 'revert')).toBe('initial');
    expect(transition('changedLeft', 'manuallyEdited', 'revert')).toBe('initial');
    expect(transition('conflict', 'initial', 'revert')).toBeNull();
  });

  test('accepting a side on an ignored chunk is invalid until reverted', () => {
    expect(transition('conflict', 'ignored', 'acceptLeft')).toBeNull();
  });
});

describe('isResolved', () => {
  test('initial is unresolved, everything else is resolved', () => {
    expect(isResolved('initial')).toBe(false);
    for (const state of [
      'appliedLeft',
      'appliedRight',
      'appliedBoth',
      'ignored',
      'manuallyEdited',
    ] as const) {
      expect(isResolved(state)).toBe(true);
    }
  });
});
