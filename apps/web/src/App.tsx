import { brandAssets } from '@solventa/assets/web';
import { useEffect, useState } from 'react';

type Session = 'loading' | 'anonymous' | 'authenticated' | 'unavailable';

export default function App() {
  const [session, setSession] = useState<Session>('loading');
  const [busy, setBusy] = useState(false);
  const failed = new URLSearchParams(window.location.search).get('auth') === 'failed';
  async function load() {
    setSession('loading');
    try {
      const response = await fetch('/auth/session', { credentials: 'same-origin' });
      setSession(response.ok ? 'authenticated' : response.status === 401 ? 'anonymous' : 'unavailable');
    } catch { setSession('unavailable'); }
  }
  useEffect(() => { void load(); }, []);
  async function logout() {
    setBusy(true);
    try {
      const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (response.status === 401) { setSession('anonymous'); return; }
      if (!response.ok) throw new Error('logout_failed');
      const { logoutUrl } = await response.json();
      window.location.assign(logoutUrl);
    } catch { setSession('unavailable'); }
    finally { setBusy(false); }
  }
  return <div className="app-shell">
    <header><img src={brandAssets.logo.green} alt="Solventa" width={174} /></header>
    <main className="access-panel" aria-busy={session === 'loading' || busy}>
      <h1>{session === 'authenticated' ? 'Tu sesión está activa' : 'Ingresa a Solventa'}</h1>
      {session === 'loading' && <p role="status">Comprobando sesión…</p>}
      {failed && session !== 'authenticated' && <p className="error" role="alert">No se completó el acceso. Intenta de nuevo.</p>}
      {session === 'anonymous' && <a className="primary-action" href="/auth/login">Continuar</a>}
      {session === 'authenticated' && <><p>Aplicación en preparación.</p><button onClick={() => void logout()} disabled={busy}>{busy ? 'Cerrando sesión…' : 'Cerrar sesión'}</button></>}
      {session === 'unavailable' && <><p role="alert">No pudimos comprobar tu sesión.</p><button onClick={() => void load()}>Reintentar</button></>}
    </main>
  </div>
}
