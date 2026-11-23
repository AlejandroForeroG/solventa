import '@testing-library/jest-dom/vitest';
import { beforeEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

expect.extend(axeMatchers);
beforeEach(() => {
  const prototype = HTMLDialogElement.prototype;
  if (typeof prototype.showModal === 'function') return;
  Object.defineProperties(prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); });
