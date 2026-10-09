import 'vitest';

// vitest-axe ships typings for an older vitest; this declares its matcher for the current one.
declare module 'vitest' {
  interface Assertion { toHaveNoViolations(): void }
  interface AsymmetricMatchersContaining { toHaveNoViolations(): void }
}
