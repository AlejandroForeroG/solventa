const es = {
  title: 'Mis indemnizaciones', empty: 'Aún no hay desembolsos autorizados.', loading: 'Consultando desembolsos…',
  privacyUnavailable: 'No pudimos proteger esta pantalla. Vuelve a abrirla.',
  back: 'Volver', next: 'Siguientes', previous: 'Anteriores', refresh: 'Consultar estado', simulated: 'Pago simulado',
  pending: 'Pendiente de confirmación', confirmed: 'Pago confirmado', declined: 'Pago rechazado', reference: 'Referencia', updated: 'Actualizado',
  pendingHelp: 'El desembolso está registrado, pero todavía no está confirmado.', locked: 'Vuelve a la app para consultar el estado.',
  failures: { unavailable: 'No pudimos consultar el estado. Reintenta con conexión.', invalid_response: 'No pudimos verificar el comprobante.',
    forbidden: 'Tu cuenta no tiene acceso a esta consulta.', unauthorized: 'Tu sesión venció. Inicia sesión de nuevo.' },
};
const en: typeof es = {
  title: 'My indemnities', empty: 'There are no authorized disbursements yet.', loading: 'Loading disbursements…',
  privacyUnavailable: 'We could not protect this screen. Open it again.',
  back: 'Back', next: 'Next', previous: 'Previous', refresh: 'Check status', simulated: 'Simulated payment',
  pending: 'Awaiting confirmation', confirmed: 'Payment confirmed', declined: 'Payment declined', reference: 'Reference', updated: 'Updated',
  pendingHelp: 'The disbursement is recorded, but it is not yet confirmed.', locked: 'Return to the app to check the status.',
  failures: { unavailable: 'We could not check the status. Retry with a connection.', invalid_response: 'We could not verify the receipt.',
    forbidden: 'Your account cannot access these payments.', unauthorized: 'Your session expired. Sign in again.' },
};
export const paymentMessages = { 'es-CO': es, 'en-US': en };
