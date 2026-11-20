import { messages } from '@/shared/i18n/messages';
import { useAppMessages } from '@/shared/i18n/use-app-messages';
import type { NoticeKind, NoticeState } from '../domain/notice';

const es = {
  // Shown on a lock screen: it names nothing about the policy, the amount or the person.
  notificationTitle: 'Solventa', notificationBody: 'Tienes un aviso nuevo. Ábrelo para verlo.',
  loading: 'Revisando tus avisos…', failed: 'No pudimos revisar tus avisos. Intenta de nuevo.', empty: 'No tienes avisos nuevos.',
  title: 'Aviso', open: 'Ver detalle', retry: 'Reintentar', back: 'Volver a avisos',
  signIn: 'Inicia sesión para abrir este aviso.',
  opening: 'Abriendo el detalle…', actionFailed: 'No pudimos abrir este aviso. Revisa tu sesión e intenta de nuevo.',
  kind: { parametric_payment_confirmed: 'Se confirmó el pago de tu póliza', policy_lifecycle_changed: 'Cambió una de tus pólizas', policy_expiring: 'Una de tus pólizas vence pronto', claim_status_changed: 'Cambió el estado de uno de tus siniestros' } satisfies Record<NoticeKind, string>,
  state: { offered: 'Pendiente', unconfirmed: 'Sin confirmar', presented: 'Notificado', permission_denied: 'Notificaciones desactivadas en este dispositivo' } satisfies Record<NoticeState, string>,
};

const en: typeof es = {
  notificationTitle: 'Solventa', notificationBody: 'You have a new notice. Open it to read it.',
  loading: 'Checking your notices…', failed: 'We could not check your notices. Try again.', empty: 'You have no new notices.',
  title: 'Notice', open: 'View details', retry: 'Try again', back: 'Back to notices',
  signIn: 'Sign in to open this notice.',
  opening: 'Opening the details…', actionFailed: 'We could not open this notice. Check your session and try again.',
  kind: { parametric_payment_confirmed: 'The payment of your policy was confirmed', policy_lifecycle_changed: 'One of your policies changed', policy_expiring: 'One of your policies expires soon', claim_status_changed: 'The status of one of your claims changed' },
  state: { offered: 'Pending', unconfirmed: 'Unconfirmed', presented: 'Notified', permission_denied: 'Notifications are off on this device' },
};

export function useNoticeMessages() {
  return useAppMessages() === messages.en ? en : es;
}
