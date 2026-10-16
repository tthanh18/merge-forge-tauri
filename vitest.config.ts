import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // Several suites build real git repos (dozens of subprocesses) and run in parallel;
    // under load a fixture build alone can blow the default 5s. This is a ceiling for
    // hangs, not a target — the suites still finish in seconds when healthy.
    testTimeout: 30_000,
  },
});
