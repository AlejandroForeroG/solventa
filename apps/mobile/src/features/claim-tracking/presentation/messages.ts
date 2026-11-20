import type { ClaimCaseEvent, ClaimCaseState } from '@solventa/contracts';

const es = {
  title: 'Mis siniestros', unnamed: 'Expediente', loading: 'Consultando el expediente…', empty: 'Todavía no tienes siniestros radicados.',
  refresh: 'Consultar de nuevo', history: 'Historial', requirements: 'Requerimientos', owner: 'Titular de la póliza', deadline: 'Fecha límite',
  pending: 'Pendiente', received: 'Recibido', receipt: 'Ver desembolso', emptyHistory: 'No hay novedades registradas.',
  unauthorized: 'Tu sesión venció. Ingresa de nuevo.', forbidden: 'Tu cuenta no tiene permiso para consultar siniestros.',
  not_found: 'No encontramos el expediente.', unavailable: 'No pudimos consultar el expediente. Revisa tu conexión e intenta de nuevo.',
  states: {
    unassigned: 'Radicado', in_review: 'En revisión', pending_information: 'Pendiente de información', escalated: 'En peritaje',
    approved: 'Aprobado', rejected: 'Rechazado', paid: 'Pagado',
  } satisfies Record<ClaimCaseState, string>,
  events: {
    submitted: 'Siniestro radicado', take: 'Comenzó la revisión', request_information: 'Se solicitó información',
    extend_requirement: 'Se amplió el plazo', respond: 'Se recibió tu respuesta', assign_expert: 'Se asignó un perito',
    approve: 'Se aprobó el siniestro', reject: 'Se rechazó el siniestro',
    disbursement_confirmed: 'Desembolso simulado confirmado', disbursement_declined: 'Desembolso simulado rechazado',
  } satisfies Record<ClaimCaseEvent, string>,
};
const en: typeof es = {
  title: 'My claims', unnamed: 'Claim details', loading: 'Loading the claim…', empty: 'You have no submitted claims yet.',
  refresh: 'Refresh', history: 'History', requirements: 'Requests for information', owner: 'Policyholder', deadline: 'Deadline',
  pending: 'Pending', received: 'Received', receipt: 'View disbursement', emptyHistory: 'No updates have been recorded.',
  unauthorized: 'Your session expired. Sign in again.', forbidden: 'Your account cannot access claims.',
  not_found: 'We could not find this claim.', unavailable: 'We could not load the claim. Check your connection and try again.',
  states: {
    unassigned: 'Submitted', in_review: 'In review', pending_information: 'Awaiting information', escalated: 'Under expert review',
    approved: 'Approved', rejected: 'Rejected', paid: 'Paid',
  },
  events: {
    submitted: 'Claim submitted', take: 'Review started', request_information: 'Information requested',
    extend_requirement: 'Deadline extended', respond: 'Response received', assign_expert: 'Expert assigned',
    approve: 'Claim approved', reject: 'Claim rejected',
    disbursement_confirmed: 'Simulated disbursement confirmed', disbursement_declined: 'Simulated disbursement declined',
  },
};
export const trackingMessages = { 'es-CO': es, 'en-US': en };
