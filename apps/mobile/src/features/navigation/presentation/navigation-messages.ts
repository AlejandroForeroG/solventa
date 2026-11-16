import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';

const es = {
  home: 'Inicio', wallet: 'Billetera', claims: 'Siniestros', alerts: 'Alertas', profile: 'Perfil',
  homeTitle: 'Inicio', walletDetail: 'Consulta tus pólizas y sus coberturas.',
  claimsDetail: 'Encuentra ayuda para tu siniestro.', alertsDetail: 'Consulta tus avisos.',
  alertsUnavailable: 'Tus avisos aparecerán aquí cuando la bandeja esté disponible.',
  reportClaim: 'Reportar siniestro', reportClaimDetail: 'Cuéntanos qué pasó y adjunta fotos o video como evidencia.',
  assistance: 'Prestadores cercanos', assistanceDetail: 'Busca talleres, peritos o asistencia vial.',
  signIn: 'Inicia sesión para acceder a esta sección.', back: 'Volver a Inicio',
};

const en: typeof es = {
  home: 'Home', wallet: 'Wallet', claims: 'Claims', alerts: 'Alerts', profile: 'Profile',
  homeTitle: 'Home', walletDetail: 'View your policies and their coverage.',
  claimsDetail: 'Find help with your claim.', alertsDetail: 'View your notifications.',
  alertsUnavailable: 'Your notifications will appear here when the inbox is available.',
  reportClaim: 'Report a claim', reportClaimDetail: 'Tell us what happened and attach photos or video as evidence.',
  assistance: 'Nearby providers', assistanceDetail: 'Find workshops, experts or roadside assistance.',
  signIn: 'Sign in to access this section.', back: 'Back to Home',
};

export function useNavigationMessages() {
  return useAppMessages() === messages.en ? en : es;
}
