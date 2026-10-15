import { AuthFailure } from '../domain/session';
import type { AuthBrowser } from '../application/ports';

type BrowserOptions = { createTask: false; useProxyActivity: false; showInRecents: false };
type BrowserSession = { type: string; url?: string };

export function createAuthBrowser(deps: {
  assertAvailable(): void;
  openSession(url: string, callback: string, options: BrowserOptions): Promise<BrowserSession>;
}): AuthBrowser {
  return {
    assertAvailable: deps.assertAvailable,
    async open(url, callback) {
      deps.assertAvailable();
      // Android returns to the existing singleTask app instead of leaving a separate browser task.
      const result = await deps.openSession(url, callback, { createTask: false, useProxyActivity: false, showInRecents: false });
      if (result.type !== 'success') return null;
      if (!result.url) throw new AuthFailure('invalid_response');
      return result.url;
    },
  };
}
