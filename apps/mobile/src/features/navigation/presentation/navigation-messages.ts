import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';

const es = {
  drafts: 'Borradores', draftsDetail: 'Prepara un reporte y retómalo, incluso sin conexión.',
  home: 'Inicio', wallet: 'Billetera', claims: 'Siniestros', alerts: 'Avisos', profile: 'Perfil', preferences: 'Preferencias de avisos',
  homeTitle: 'Inicio', walletDetail: 'Consulta tus pólizas y sus coberturas.',
  claimsDetail: 'Encuentra ayuda para tu siniestro.', alertsDetail: 'Consulta tus avisos.',
  reportClaim: 'Reportar siniestro', reportClaimDetail: 'Cuéntanos qué pasó y adjunta fotos o video como evidencia.',
  assistance: 'Prestadores cercanos', assistanceDetail: 'Busca talleres, peritos o asistencia vial.',
  signIn: 'Inicia sesión para acceder a esta sección.', back: 'Volver a Inicio',
};

const en: typeof es = {
  drafts: 'Drafts', draftsDetail: 'Prepare a report and resume it, even offline.',
  home: 'Home', wallet: 'Wallet', claims: 'Claims', alerts: 'Notices', profile: 'Profile', preferences: 'Notification preferences',
  homeTitle: 'Home', walletDetail: 'View your policies and their coverage.',
  claimsDetail: 'Find help with your claim.', alertsDetail: 'View your notifications.',
  reportClaim: 'Report a claim', reportClaimDetail: 'Tell us what happened and attach photos or video as evidence.',
  assistance: 'Nearby providers', assistanceDetail: 'Find workshops, experts or roadside assistance.',
  signIn: 'Sign in to access this section.', back: 'Back to Home',
};

export function useNavigationMessages() {
  return useAppMessages() === messages.en ? en : es;
}
