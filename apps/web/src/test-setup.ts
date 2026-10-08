import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

expect.extend(axeMatchers);
afterEach(() => { cleanup(); window.localStorage.clear(); });
