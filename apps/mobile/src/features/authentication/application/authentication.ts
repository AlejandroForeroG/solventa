import { AuthFailure, emptyRecord } from '../domain/session';
import type { AuthRecord, AuthSnapshot, FailureKind, Principal, ProviderSession, StoredSession } from '../domain/session';
import type { AuthBrowser, BiometricVault, IdentityProvider, OAuthCallback, SessionApi, TokenStore } from './ports';

type Dependencies = {
  baseUrl: string;
  store: TokenStore;
  identity: IdentityProvider;
  api: SessionApi;
  browser: AuthBrowser;
  biometrics?: BiometricVault;
  now: () => number;
  parseCallback: (url: string) => OAuthCallback;
};

export class Authentication {
  private snapshot: AuthSnapshot = { status: 'loading' };
  private listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private record: AuthRecord | undefined;
  private loginInFlight = false;
  private logoutRequested = false;
  private device: string | undefined;
  private primaryAuthenticated = false;
  private lockVersion = 0;
  private foreground = true;
  private warmSession = false;

  constructor(private readonly deps: Dependencies) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(snapshot: AuthSnapshot) {
    if (this.logoutRequested && snapshot.status === 'authenticated') return;
    if (!this.foreground && snapshot.status === 'authenticated') {
      if (!this.warmSession) this.record = undefined;
      this.snapshot = { status: this.warmSession ? 'loading' : this.device ? 'locked' : 'loading' };
      this.listeners.forEach(listener => listener());
      return;
    }
    if (snapshot.status === 'authenticated') this.warmSession = true;
    else if (snapshot.status !== 'loading' && snapshot.status !== 'biometricPrompt') this.warmSession = false;
    this.snapshot = snapshot.status === 'authenticated' ? { ...snapshot, email: this.record?.session?.email } : snapshot;
    this.listeners.forEach(listener => listener());
  }

  // Serialize storage, callback consumption and token rotation across all entry points.
  private run(operation: () => Promise<void>, preflight?: () => void | Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      try {
        await preflight?.();
        await this.load();
        await operation();
      } catch (error) {
        await this.handleFailure(error);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load() {
    if (this.record) return;
    const binding = await this.deps.biometrics?.info();
    if (binding) {
      if (binding.baseUrl !== this.deps.baseUrl) {
        await this.deps.biometrics?.clear();
        await this.deps.store.write(emptyRecord());
      }
    }
    const record = await this.deps.store.read();
    const context = record.session ?? record.transaction;
    if (context && context.baseUrl !== this.deps.baseUrl) {
      await this.save(emptyRecord());
    } else {
      this.record = record;
    }
  }

  private async save(record: AuthRecord) {
    if (record.session?.phase !== 'active') this.warmSession = false;
    if (record.session?.phase === 'logout') record = { ...record, session: { ...record.session, email: undefined } };
    await this.deps.store.write(record);
    this.record = record;
  }

  private async handleFailure(error: unknown) {
    this.warmSession = false;
    const failure = error instanceof AuthFailure ? error : new AuthFailure('unavailable');
    const session = this.record?.session;
    if (failure.kind === 'biometric_locked' || failure.kind === 'biometric_failed') {
      this.record = undefined;
      this.primaryAuthenticated = false;
      this.publish({ status: 'locked', failure: failure.kind });
      return;
    }
    if (failure.kind === 'unauthorized') {
      try {
        await this.save(emptyRecord());
        await this.deps.biometrics?.clear();
        this.device = undefined;
        this.primaryAuthenticated = false;
      } catch {
        this.record = undefined;
        this.publish({ status: this.logoutRequested || session?.phase === 'logout' ? 'logoutPending' : 'blocked', failure: 'unavailable' });
        return;
      }
      this.publish({ status: 'signedOut', failure: session?.phase === 'logout' ? 'logout_unconfirmed' : 'unauthorized', traceId: failure.traceId });
      return;
    }
    this.publish({
      status: this.logoutRequested || session?.phase === 'logout' ? 'logoutPending' : session ? 'blocked' : 'signedOut',
      failure: failure.kind,
      traceId: failure.traceId,
    });
  }

  restore = () => this.run(async () => {
    const transaction = this.record?.transaction;
    if (transaction) {
      if (transaction.expiresAt <= this.deps.now()) {
        await this.finishPrimaryAttempt('invalid_callback');
      } else {
        this.publish({ status: 'authorizing' });
      }
      return;
    }
    if (!this.record?.session) {
      this.logoutRequested = false;
      if (await this.deps.biometrics?.resume()) {
        this.record = undefined;
        this.publish({ status: 'locked' });
        return;
      }
      this.publish({ status: 'signedOut' });
      return;
    }
    if (this.logoutRequested && this.record.session.phase !== 'logout') {
      await this.save({ version: 1, transaction: null, session: { ...this.record.session, phase: 'logout' } });
    }
    this.publish({ status: this.record.session.phase === 'logout' ? 'logoutPending' : 'loading' });
    await this.connect();
  });

  signIn = async () => {
    if (this.loginInFlight || this.snapshot.status === 'authorizing') return;
    this.loginInFlight = true;
    let authorization: { url: string; redirectUri: string } | undefined;
    await this.run(async () => {
      if (this.record?.session) return;
      this.logoutRequested = false;
      this.publish({ status: 'loading' });
      const configuration = await this.deps.api.configuration();
      const { url, state, codeVerifier } = await this.deps.identity.authorize(configuration);
      await this.save({ version: 1, session: null, transaction: {
        configuration, baseUrl: this.deps.baseUrl, state, codeVerifier,
        expiresAt: this.deps.now() + 10 * 60_000,
      } });
      authorization = { url, redirectUri: configuration.redirectUri };
      this.publish({ status: 'authorizing' });
    }, async () => {
      this.deps.browser.assertAvailable();
      if (this.logoutRequested || this.record?.session?.phase === 'logout') return;
      const binding = await this.deps.biometrics?.info();
      if (binding || this.snapshot.status === 'locked') {
        if (binding?.baseUrl === this.deps.baseUrl) await this.deps.biometrics?.suspend();
        else {
          await this.deps.biometrics?.clear();
          await this.deps.store.write(emptyRecord());
        }
        this.record = emptyRecord();
        this.device = undefined;
        this.warmSession = false;
        this.primaryAuthenticated = false;
      }
    });
    try {
      if (!authorization) return;
      const callback = await this.deps.browser.open(authorization.url, authorization.redirectUri);
      if (callback) await this.complete(callback);
      else await this.cancel();
    } catch (error) {
      await this.run(async () => {
        // A deep link may have already completed while the browser was closing.
        if (!this.record?.transaction) return;
        await this.finishPrimaryAttempt(error instanceof AuthFailure ? error.kind : 'unavailable');
      });
    } finally {
      this.loginInFlight = false;
    }
  };

  complete = (url: string) => this.run(async () => {
    const transaction = this.record?.transaction;
    if (!transaction) {
      if (!this.record?.session) throw new AuthFailure('invalid_callback');
      if (this.snapshot.status === 'loading') await this.connect();
      return;
    }
    const callback = this.deps.parseCallback(url);
    if (callback.state !== transaction.state || transaction.expiresAt <= this.deps.now()) {
      throw new AuthFailure('invalid_callback');
    }
    // Consume before exchange, including provider errors; never redeem a code twice.
    await this.save(emptyRecord());
    if (callback.error) {
      await this.finishPrimaryAttempt(callback.error === 'access_denied' ? 'cancelled' : 'unauthorized');
      return;
    }
    if (!callback.code) throw new AuthFailure('invalid_callback');
    this.publish({ status: 'loading' });
    let result: ProviderSession;
    try {
      result = await this.deps.identity.exchange(transaction.configuration, callback.code, transaction.codeVerifier);
    } catch (error) {
      await this.finishPrimaryAttempt(error instanceof AuthFailure ? error.kind : 'unavailable');
      return;
    }
    const { email, ...tokens } = result;
    await this.save({ version: 1, transaction: null, session: {
      configuration: transaction.configuration, baseUrl: transaction.baseUrl, tokens, phase: 'bootstrap',
      ...(email ? { email } : {}),
    } });
    this.primaryAuthenticated = true;
    await this.connect();
  });

  cancel = () => this.run(async () => {
    if (!this.record?.transaction) return;
    await this.finishPrimaryAttempt('cancelled');
  });

  private async finishPrimaryAttempt(failure: FailureKind) {
    await this.save(emptyRecord());
    const resumed = await this.deps.biometrics?.resume();
    this.primaryAuthenticated = false;
    this.device = undefined;
    if (resumed) this.record = undefined;
    this.publish({ status: resumed ? 'locked' : 'signedOut', ...(failure === 'cancelled' ? {} : { failure }) });
  }

  retry = () => this.restore();

  lock = () => {
    if (!this.foreground) return;
    this.foreground = false;
    if (this.snapshot.status === 'biometricPrompt' || this.logoutRequested) return;
    if (this.warmSession && this.record?.session?.phase === 'active') {
      this.lockVersion++;
      // Keep only the already-unlocked session in RAM; foreground return still revalidates access.
      this.publish({ status: 'loading' });
    } else if (this.device) {
      this.lockVersion++;
      this.primaryAuthenticated = false;
      this.record = undefined;
      this.publish({ status: 'locked' });
    }
  };

  resume = () => { this.foreground = true; };

  enableBiometrics = () => this.run(async () => {
    if (!this.primaryAuthenticated || this.snapshot.status !== 'authenticated' || !this.record?.session) throw new AuthFailure('unauthorized');
    const vault = this.deps.biometrics;
    if (!vault) throw new AuthFailure('biometric_unavailable');
    const principal = this.snapshot.principal;
    if (!principal) throw new AuthFailure('unauthorized');
    await this.activateBiometrics(principal, vault);
  });

  private async activateBiometrics(principal: Principal, vault: BiometricVault) {
    this.publish({ status: 'biometricPrompt' });
    await this.request(token => this.deps.api.inspect(token));
    const preparedRecord = this.record;
    if (!preparedRecord) throw new AuthFailure('unauthorized');
    const installationId = await vault.prepare(preparedRecord);
    try {
      await this.request(token => this.deps.api.registerDevice(token, installationId));
      // A long biometric prompt can cross the refresh threshold. Never commit the old pair.
      const current = this.record;
      if (!current?.session) throw new AuthFailure('unauthorized');
      if (current !== preparedRecord) await vault.prepare(current);
      await vault.commit(installationId, this.deps.baseUrl, principal);
      this.device = installationId;
      this.publish({ status: 'authenticated', principal, biometricEnabled: true });
    } catch (error) {
      // A failed activation must never leave a usable biometric binding on the phone.
      await vault.clear();
      throw error;
    }
  }

  unlock = () => this.run(async () => {
    this.publish({ status: 'loading' });
    await this.connect();
  }, async () => {
    this.warmSession = false;
    const vault = this.deps.biometrics;
    const binding = await vault?.info();
    if (!vault || !binding || binding.suspended || binding.baseUrl !== this.deps.baseUrl) throw new AuthFailure('unauthorized');
    this.publish({ status: 'biometricPrompt' });
    const record = await vault.unlock();
    if (!record.session || record.session.baseUrl !== this.deps.baseUrl || record.session.phase !== 'active') throw new AuthFailure('unauthorized');
    this.device = binding.installationId;
    this.record = record;
  });

  revokeDevice = () => {
    if (!this.device) return Promise.resolve();
    return this.endSession(this.device);
  };

  signOut = () => this.endSession();

  private endSession(installationId?: string) {
    this.logoutRequested = true;
    this.publish({ status: 'logoutPending' });
    return this.run(async () => {
      if (!this.record?.session) {
        await this.save(emptyRecord());
        await this.deps.biometrics?.clear();
        this.device = undefined;
        this.primaryAuthenticated = false;
        this.logoutRequested = false;
        this.publish({ status: 'signedOut' });
        return;
      }
      await this.save({ version: 1, transaction: null, session: { ...this.record.session, phase: 'logout',
        ...(installationId ? { revocationInstallationId: installationId } : {}) } });
      await this.connect();
    });
  }

  private async freshSession(): Promise<StoredSession> {
    const session = this.record?.session;
    if (!session) throw new AuthFailure('unauthorized');
    if (session.tokens.expiresAt > this.deps.now() + 60_000) return session;
    // Rotating protected credentials can prompt on Android. Require explicit biometric entry instead.
    if (this.device && this.warmSession && session.phase === 'active') throw new AuthFailure('biometric_locked');
    const { email, ...tokens } = await this.deps.identity.refresh(session.configuration, session.tokens.refreshToken);
    const updated = { ...session, tokens, ...(email && session.phase !== 'logout' ? { email } : {}) };
    await this.save({ version: 1, transaction: null, session: updated });
    return updated;
  }

  private async request<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    const session = await this.freshSession();
    try {
      return await operation(session.tokens.accessToken);
    } catch (error) {
      // Only token expiry can trigger this retry, not a revoked local session.
      if (!(error instanceof AuthFailure) || error.kind !== 'unauthorized' || session.tokens.expiresAt > this.deps.now()) throw error;
      const refreshed = await this.freshSession();
      return operation(refreshed.tokens.accessToken);
    }
  }

  private async connect() {
    const lockVersion = this.lockVersion;
    const session = this.record?.session;
    if (!session) throw new AuthFailure('unauthorized');
    if (session.phase === 'logout') {
      const installationId = session.revocationInstallationId;
      if (installationId) await this.request(token => this.deps.api.revokeDevice(token, installationId));
      else await this.request(token => this.deps.api.logout(token));
      await this.save(emptyRecord());
      await this.deps.biometrics?.clear();
      this.device = undefined;
      this.primaryAuthenticated = false;
      this.logoutRequested = false;
      this.publish({ status: 'signedOut' });
      return;
    }
    if (session.phase === 'bootstrap') {
      await this.request(token => this.deps.api.register(token));
      const current = this.record?.session;
      if (!current) throw new AuthFailure('unauthorized');
      await this.save({ version: 1, transaction: null, session: { ...current, phase: 'active' } });
    }
    const principal = await this.request(token => this.deps.api.inspect(token));
    if (lockVersion !== this.lockVersion) { if (!this.warmSession) this.record = undefined; return; }
    const actor = await this.request(token => this.deps.api.access(token));
    if (lockVersion !== this.lockVersion) { if (!this.warmSession) this.record = undefined; return; }
    const device = this.device;
    if (device) await this.request(token => this.deps.api.inspectDevice(token, device));
    if (actor.clientId !== principal.clientId || actor.subjectToken !== principal.subjectToken) throw new AuthFailure('invalid_response');
    if (lockVersion !== this.lockVersion) { if (!this.warmSession) this.record = undefined; return; }
    const vault = this.deps.biometrics;
    const binding = await vault?.info();
    if (device && vault && binding) {
      // Upgrade legacy activation metadata only after protected unlock and server validation.
      await vault.commit(device, this.deps.baseUrl, principal);
    } else if (binding?.suspended && vault) {
      if (binding.owner?.clientId !== principal.clientId || binding.owner.subjectToken !== principal.subjectToken) {
        await vault.clear();
      } else if (this.primaryAuthenticated && this.foreground && !this.logoutRequested) {
        await this.activateBiometrics(principal, vault);
        return;
      }
    }
    this.publish({ status: 'authenticated', principal, biometricEnabled: Boolean(this.device),
      canEnableBiometrics: this.primaryAuthenticated && Boolean(this.deps.biometrics) });
  }
}
