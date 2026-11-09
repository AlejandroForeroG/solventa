import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';

const es = {
  home: 'Inicio', wallet: 'Billetera', claims: 'Siniestros', alerts: 'Alertas', profile: 'Perfil',
  homeTitle: 'Inicio', walletDetail: 'Consulta tus pólizas y sus coberturas.',
  claimsDetail: 'Encuentra ayuda para tu siniestro.', alertsDetail: 'Elige cómo recibir avisos.',
  assistance: 'Prestadores cercanos', assistanceUnavailable: 'La búsqueda de prestadores todavía no está disponible.',
  signIn: 'Inicia sesión para acceder a esta sección.', back: 'Volver a Inicio',
};

const en: typeof es = {
  home: 'Home', wallet: 'Wallet', claims: 'Claims', alerts: 'Alerts', profile: 'Profile',
  homeTitle: 'Home', walletDetail: 'View your policies and their coverage.',
  claimsDetail: 'Find help with your claim.', alertsDetail: 'Choose how you receive notifications.',
  assistance: 'Nearby providers', assistanceUnavailable: 'Provider search is not available yet.',
  signIn: 'Sign in to access this section.', back: 'Back to Home',
};

export function useNavigationMessages() {
  return useAppMessages() === messages.en ? en : es;
}
