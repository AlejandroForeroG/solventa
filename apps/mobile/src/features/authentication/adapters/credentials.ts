import { AuthFailure, emptyRecord } from '../domain/session';
import type { AuthRecord } from '../domain/session';
import type { BiometricVault, TokenStore } from '../application/ports';
import { object, principal, storedRecord, text, trace } from './validation';

type Custody = {
  read(key: string, protectedValue?: boolean): Promise<string | null>;
  write(key: string, value: string, protectedValue?: boolean): Promise<void>;
  remove(key: string, protectedValue?: boolean): Promise<void>;
  installationId(): Promise<string>;
  assertBiometrics(): Promise<void>;
};
const keys = { installation: 'solventa.installation.v1', plain: 'solventa.authentication.v1', protected: 'solventa.biometric.credentials.v1', binding: 'solventa.biometric.binding.v1' };

export function createCredentials(custody: Custody): { store: TokenStore; vault: BiometricVault } {
  let initialized: Promise<string> | undefined;
  async function clear() {
    // Remove the activation marker first: partial cleanup cannot enable access.
    await custody.remove(keys.binding);
    await custody.remove(keys.protected, true);
  }
  function installation() {
    initialized ??= (async () => {
      const id = await custody.installationId();
      if (!trace(id) || id[14] !== '4') throw new AuthFailure('invalid_response');
      if (await custody.read(keys.installation) !== id) {
        await clear();
        await custody.remove(keys.plain);
        await custody.write(keys.installation, id);
      }
      return id;
    })().catch(error => { initialized = undefined; throw error; });
    return initialized;
  }
  async function info() {
    const id = await installation();
    const value = await custody.read(keys.binding);
    if (!value) return null;
    try {
      const data = object(JSON.parse(value));
      if (data.installationId !== id) throw new AuthFailure('invalid_response');
      if (data.suspended !== undefined && typeof data.suspended !== 'boolean') throw new AuthFailure('invalid_response');
      const owner = data.owner === undefined ? undefined : principal(data.owner);
      return { installationId: id, baseUrl: text(data.baseUrl, 512), owner, suspended: data.suspended === true };
    } catch {
      await clear();
      await custody.remove(keys.plain);
      throw new AuthFailure('unauthorized');
    }
  }
  async function protectedRecord() {
    await custody.assertBiometrics();
    let value;
    try { value = await custody.read(keys.protected, true); }
    catch { throw new AuthFailure('biometric_failed'); }
    if (!value) throw new AuthFailure('unauthorized');
    try {
      const data = object(JSON.parse(value));
      if (data.installationId !== await installation()) throw new AuthFailure('invalid_response');
      return storedRecord(data.record);
    } catch { throw new AuthFailure('unauthorized'); }
  }
  const vault: BiometricVault = {
    info,
    async suspend() {
      const binding = await info();
      if (binding) {
        // Legacy ownerless bindings can return to locked entry on cancellation, not enroll a new session.
        await custody.write(keys.binding, JSON.stringify({ ...binding, suspended: true }));
      }
      await custody.remove(keys.plain);
    },
    async resume() {
      const binding = await info();
      if (!binding?.suspended) return false;
      await custody.write(keys.binding, JSON.stringify({ ...binding, suspended: false }));
      return true;
    },
    async prepare(record) {
      const id = await installation();
      await custody.assertBiometrics();
      if (!record.session || record.session.phase !== 'active' || record.transaction) throw new AuthFailure('unauthorized');
      try {
        await custody.write(keys.protected, JSON.stringify({ installationId: id, record }), true);
        // iOS key creation does not prompt; reading proves the key actually requires biometrics.
        const verified = await protectedRecord();
        const session = verified.session;
        if (!session || session.phase !== 'active' || session.baseUrl !== record.session.baseUrl
          || session.configuration.clientId !== record.session.configuration.clientId
          || session.tokens.accessToken !== record.session.tokens.accessToken
          || session.tokens.refreshToken !== record.session.tokens.refreshToken
          || session.tokens.expiresAt !== record.session.tokens.expiresAt) throw new AuthFailure('unauthorized');
      } catch (error) {
        await clear();
        throw error instanceof AuthFailure ? error : new AuthFailure('biometric_failed');
      }
      return id;
    },
    async commit(installationId, baseUrl, owner) {
      if (installationId !== await installation()) throw new AuthFailure('unauthorized');
      await custody.write(keys.binding, JSON.stringify({ installationId, baseUrl, owner: principal(owner) }));
      await custody.remove(keys.plain);
    },
    async unlock() {
      if ((await info())?.suspended) throw new AuthFailure('unauthorized');
      return protectedRecord();
    },
    clear,
  };
  const store: TokenStore = {
    async read() {
      await installation();
      const value = await custody.read(keys.plain);
      let record: AuthRecord;
      try { record = value ? storedRecord(JSON.parse(value)) : emptyRecord(); }
      catch {
        await clear();
        await custody.remove(keys.plain);
        return emptyRecord();
      }
      // A durable logout intent may use encrypted, non-biometric custody only for revocation.
      if (record.session?.phase === 'logout') return record;
      const binding = await info();
      if (binding && !binding.suspended) throw new AuthFailure('biometric_locked');
      return record;
    },
    async write(record: AuthRecord) {
      const id = await installation();
      if (!record.session && !record.transaction) {
        if (!(await info())?.suspended) await clear();
        await custody.remove(keys.plain);
      } else if (record.session?.phase === 'logout') {
        await custody.write(keys.plain, JSON.stringify(record));
        await clear();
      } else if (await info().then(binding => binding && !binding.suspended)) {
        try { await custody.write(keys.protected, JSON.stringify({ installationId: id, record }), true); }
        catch { throw new AuthFailure('biometric_failed'); }
      } else await custody.write(keys.plain, JSON.stringify(record));
    },
  };
  return { store, vault };
}
