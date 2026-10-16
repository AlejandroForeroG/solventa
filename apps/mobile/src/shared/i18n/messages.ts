const es = {
  headings: {
    authenticated: 'Sesión iniciada', locked: 'Vuelve a tu cuenta', blocked: 'Revisa la conexión',
    logoutPending: 'Cierre pendiente', signedOut: 'Bienvenido a Solventa', signIn: 'Inicia sesión',
  },
  introduction: 'Aquí puedes gestionar tus productos y cuidar tu bienestar en un solo lugar.',
  authorizing: 'Completa el ingreso en el navegador.',
  biometricPrompt: 'Confirma tu huella o rostro.',
  verifying: 'Verificando tu sesión…',
  reference: 'Referencia',
  or: 'o',
  currentAccount: 'CUENTA ACTUAL',
  biometricEnabled: 'Biometría activada',
  biometricSetup: 'Configura tu acceso biométrico',
  biometricReady: 'Puedes volver a entrar con tu huella o rostro.',
  biometricDescription: 'Usa la huella o el rostro de tu dispositivo para volver a entrar.',
  primaryRequired: 'Cierra e inicia sesión nuevamente para activar la biometría.',
  pendingLogout: 'El acceso está bloqueado hasta confirmar el cierre remoto.',
  nativeOnly: 'El ingreso está disponible en la app nativa.',
  securePrompt: 'Confirma tu identidad para entrar a Solventa',
  actions: {
    signIn: 'Iniciar sesión', unlock: 'Entrar con huella o rostro', alternative: 'Usar inicio de sesión',
    enable: 'Activar huella o rostro', revoke: 'Revocar acceso de este dispositivo', retry: 'Reintentar conexión',
    retryLogout: 'Reintentar cierre', signOut: 'Cerrar sesión', cancel: 'Cancelar',
  },
  failures: {
    unavailable: 'No pudimos conectar. Intenta de nuevo.',
    unauthorized: 'Tu sesión no es válida. Inicia sesión de nuevo.',
    forbidden: 'Tu cuenta no tiene acceso.',
    invalid_callback: 'El intento de ingreso no es válido o expiró.',
    invalid_response: 'No pudimos validar la conexión.',
    cancelled: 'Ingreso cancelado.',
    native_required: 'Usa la app instalada para iniciar sesión.',
    biometric_locked: 'Confirma tu identidad para entrar.',
    biometric_unavailable: 'No hay biometría segura disponible. Usa el inicio de sesión.',
    biometric_failed: 'No pudimos confirmar tu identidad. Reintenta o usa el inicio de sesión.',
    logout_unconfirmed: 'Sesión cerrada en este dispositivo. No pudimos confirmar el cierre remoto.',
  },
};

const en: typeof es = {
  headings: {
    authenticated: 'Signed in', locked: 'Welcome back', blocked: 'Check your connection',
    logoutPending: 'Sign-out pending', signedOut: 'Welcome to Solventa', signIn: 'Sign in',
  },
  introduction: 'Manage your products and take care of your wellbeing, all in one place.',
  authorizing: 'Complete sign-in in your browser.',
  biometricPrompt: 'Confirm your fingerprint or face.',
  verifying: 'Verifying your session…',
  reference: 'Reference',
  or: 'or',
  currentAccount: 'CURRENT ACCOUNT',
  biometricEnabled: 'Biometrics enabled',
  biometricSetup: 'Set up biometric sign-in',
  biometricReady: 'You can sign in again with your fingerprint or face.',
  biometricDescription: 'Use your device’s fingerprint or face recognition to sign in again.',
  primaryRequired: 'Sign out and sign in again to enable biometrics.',
  pendingLogout: 'Access is blocked until remote sign-out is confirmed.',
  nativeOnly: 'Sign-in is available in the native app.',
  securePrompt: 'Confirm your identity to access Solventa',
  actions: {
    signIn: 'Sign in', unlock: 'Sign in with fingerprint or face', alternative: 'Use account sign-in',
    enable: 'Enable fingerprint or face', revoke: 'Revoke access for this device', retry: 'Retry connection',
    retryLogout: 'Retry sign-out', signOut: 'Sign out', cancel: 'Cancel',
  },
  failures: {
    unavailable: 'We couldn’t connect. Please try again.',
    unauthorized: 'Your session is no longer valid. Please sign in again.',
    forbidden: 'Your account does not have access.',
    invalid_callback: 'This sign-in attempt is invalid or has expired.',
    invalid_response: 'We couldn’t verify the connection.',
    cancelled: 'Sign-in cancelled.',
    native_required: 'Use the installed app to sign in.',
    biometric_locked: 'Confirm your identity to sign in.',
    biometric_unavailable: 'Secure biometrics are unavailable. Use account sign-in.',
    biometric_failed: 'We couldn’t confirm your identity. Try again or use account sign-in.',
    logout_unconfirmed: 'Signed out on this device. We couldn’t confirm remote sign-out.',
  },
};

export const messages = { es, en };
export type Language = keyof typeof messages;

export function resolveLanguage(preferredLocales: readonly string[]): Language {
  for (const locale of preferredLocales) {
    const language = locale.toLowerCase().split(/[-_]/)[0];
    if (language === 'es' || language === 'en') return language;
  }
  return 'es';
}

export function messagesForLocales(preferredLocales: readonly string[]) {
  return messages[resolveLanguage(preferredLocales)];
}
