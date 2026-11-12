import type { PolicyProduct } from '../../policy-cache/domain/cached-policy';
import type { ClaimFailureCode } from '../application/ports';
import type { EventType, Issue, RejectedCandidate } from '../domain/report';

export type ClaimReportLocale = 'es-CO' | 'en-US';

type Copy = {
  title: string; back: string; retry: string; cancel: string; step: (step: number) => string;
  policy: { heading: string; loading: string; failed: string; none: string; partial: string; signedOut: string; unknown: string }; resuming: string;
  fields: { eventType: string; occurredAt: string; date: string; time: string; place: string; placeHint: string; description: string; descriptionHint: string;
    counter: (used: number, max: number) => string; minimum: (min: number) => string };
  eventTypes: Record<EventType, string>;
  evidence: { heading: string; empty: string; takePhoto: string; recordVideo: string; choose: string; counts: (files: number, max: number, megabytes: string, maxMegabytes: number) => string;
    photo: string; video: string; previewing: string; noPreview: string; remove: (kind: string, position: number) => string };
  permission: { camera: string; openSettings: string };
  rejected: Record<RejectedCandidate | 'failed', string>;
  issues: { eventType: { required: string }; occurredAt: { future: string; before_coverage: string; after_coverage: string };
    description: { too_short: string; too_long: string }; place: { too_long: string }; evidence: { none: string; too_many: string; total_size: string } };
  review: { heading: string; next: (count: number) => string; policy: string; edit: string; files: (count: number, megabytes: string) => string; note: string; send: string };
  sending: { preparing: string; creating: string; uploading: (done: number, total: number) => string; submitting: string };
  failures: Record<Exclude<ClaimFailureCode, 'incomplete'>, string> & { incomplete: (missing: number) => string };
  done: { heading: string; caseNumber: string; filedAt: string; evidence: string; once: string; home: string };
  // Every product needs a name, even one that cannot be reported, so a new product fails the build here instead of showing a blank.
  continue: string; products: Record<PolicyProduct, string>;
};

const es: Copy = {
  title: 'Reportar siniestro', back: 'Volver', retry: 'Reintentar', cancel: 'Cancelar', step: step => `Paso ${step} de 3`,
  policy: { heading: 'Elige la póliza', loading: 'Cargando tus pólizas…', failed: 'No pudimos cargar tus pólizas. Intenta de nuevo.',
    none: 'No tienes pólizas de Vida hipotecario vigentes para reportar un siniestro.', partial: 'Solo revisamos tus 6 pólizas más recientes. Si la póliza que buscas es más antigua, aún no podemos mostrarla aquí.', signedOut: 'Inicia sesión para reportar un siniestro.', unknown: 'No encontramos esa póliza entre las que admiten un reporte.' },
  fields: { eventType: 'Tipo de evento', occurredAt: 'Cuándo ocurrió', date: 'Fecha', time: 'Hora', place: 'Lugar (opcional)', placeHint: 'Dirección o referencia',
    description: 'Qué pasó', descriptionHint: 'Describe el hecho en una o dos frases', counter: (used, max) => `${used} / ${max} caracteres`, minimum: min => `Mínimo ${min} caracteres` },
  eventTypes: { collision: 'Colisión', theft: 'Robo', damage: 'Daño', other: 'Otro' },
  evidence: { heading: 'Evidencia', empty: 'Agrega al menos una foto o un video.', takePhoto: 'Tomar foto', recordVideo: 'Grabar video', choose: 'Elegir de la galería',
    counts: (files, max, megabytes, maxMegabytes) => `${files} / ${max} archivos · ${megabytes} / ${maxMegabytes} MB`, photo: 'Foto', video: 'Video', previewing: 'Preparando vista previa', noPreview: 'Sin vista previa',
    remove: (kind, position) => `Quitar ${kind} ${position}` },
  permission: { camera: 'Para tomar fotos o grabar video necesitamos el permiso de la cámara. Puedes adjuntar archivos de tu galería sin él.', openSettings: 'Abrir ajustes' },
  rejected: { file_type: 'Solo se aceptan fotos JPG, PNG o HEIC y videos MP4 o MOV.', empty: 'Uno de los archivos está vacío.', too_many: 'Un reporte admite como máximo 10 archivos.',
    total_size: 'Los archivos no pueden superar 50 MB en total.', unreadable: 'No pudimos leer uno de los archivos.', failed: 'No pudimos abrir la cámara o la galería.' },
  issues: { eventType: { required: 'Elige el tipo de evento.' },
    occurredAt: { future: 'La fecha y la hora no pueden ser futuras.', before_coverage: 'El evento es anterior al inicio de tu póliza.', after_coverage: 'El evento es posterior al vencimiento de tu póliza.' },
    description: { too_short: 'Cuéntanos qué pasó (mínimo 40 caracteres).', too_long: 'La descripción supera los 600 caracteres.' }, place: { too_long: 'El lugar supera los 120 caracteres.' },
    evidence: { none: 'Agrega al menos una foto o un video.', too_many: 'Un reporte admite como máximo 10 archivos.', total_size: 'Los archivos no pueden superar 50 MB en total.' } },
  review: { heading: 'Revisa antes de enviar', next: count => `Revisar evidencia (${count})`, policy: 'Póliza', edit: 'Editar', files: (count, megabytes) => `${count} ${count === 1 ? 'archivo' : 'archivos'} · ${megabytes} MB`,
    note: 'Al enviar creamos un único caso. Si el envío se interrumpe, reintentar no genera un caso nuevo.', send: 'Enviar reporte' },
  sending: { preparing: 'Preparando los archivos…', creating: 'Creando el reporte…', uploading: (done, total) => `Enviando archivos (${done} de ${total})…`, submitting: 'Confirmando el reporte…' },
  failures: { unauthorized: 'Tu sesión no es válida. Inicia sesión de nuevo.', forbidden: 'Tu cuenta no puede reportar siniestros.',
    invalid: 'Revisa los datos del reporte e inténtalo de nuevo.', not_found: 'No encontramos esa póliza. Elige otra e inténtalo de nuevo.',
    outside_coverage: 'La fecha del evento está fuera de la vigencia de tu póliza.', conflict: 'El reporte cambió mientras se enviaba. Revísalo y envíalo de nuevo.',
    integrity: 'Un archivo cambió mientras se enviaba. Quítalo y vuelve a agregarlo.', media: 'El servicio no aceptó el tipo de uno de los archivos.',
    incomplete: missing => `Faltan ${missing} ${missing === 1 ? 'archivo' : 'archivos'} por recibir. Tu reporte todavía no está radicado.`,
    unavailable: 'No pudimos completar el envío. Tu reporte todavía no está radicado. Inténtalo de nuevo.', invalid_response: 'El servicio respondió algo inesperado. Inténtalo más tarde.' },
  done: { heading: 'Reporte recibido', caseNumber: 'Número de caso', filedAt: 'Radicado', evidence: 'Evidencia', once: 'Un solo caso: volver a enviar no crea otro.', home: 'Volver al inicio' },
  resuming: 'Verificando tu sesión…',
  continue: 'Continuar', products: { vida_hipotecario: 'Vida hipotecario', flight_delay: 'Retraso de vuelo', weather_event: 'Lluvia intensa' },
};

const en: Copy = {
  title: 'Report a claim', back: 'Back', retry: 'Try again', cancel: 'Cancel', step: step => `Step ${step} of 3`,
  policy: { heading: 'Choose the policy', loading: 'Loading your policies…', failed: 'We could not load your policies. Try again.',
    none: 'You have no active mortgage life policy to report a claim on.', partial: 'We only checked your 6 most recent policies. If the one you need is older, it cannot be shown here yet.', signedOut: 'Sign in to report a claim.', unknown: 'We did not find that policy among the ones that accept a report.' },
  fields: { eventType: 'Type of event', occurredAt: 'When it happened', date: 'Date', time: 'Time', place: 'Place (optional)', placeHint: 'Address or landmark',
    description: 'What happened', descriptionHint: 'Describe what happened in one or two sentences', counter: (used, max) => `${used} / ${max} characters`, minimum: min => `At least ${min} characters` },
  eventTypes: { collision: 'Collision', theft: 'Theft', damage: 'Damage', other: 'Other' },
  evidence: { heading: 'Evidence', empty: 'Add at least one photo or video.', takePhoto: 'Take a photo', recordVideo: 'Record a video', choose: 'Choose from gallery',
    counts: (files, max, megabytes, maxMegabytes) => `${files} / ${max} files · ${megabytes} / ${maxMegabytes} MB`, photo: 'Photo', video: 'Video', previewing: 'Preparing preview', noPreview: 'No preview',
    remove: (kind, position) => `Remove ${kind} ${position}` },
  permission: { camera: 'To take photos or record video we need the camera permission. You can attach files from your gallery without it.', openSettings: 'Open settings' },
  rejected: { file_type: 'Only JPG, PNG or HEIC photos and MP4 or MOV videos are accepted.', empty: 'One of the files is empty.', too_many: 'A report accepts at most 10 files.',
    total_size: 'Files cannot exceed 50 MB in total.', unreadable: 'We could not read one of the files.', failed: 'We could not open the camera or the gallery.' },
  issues: { eventType: { required: 'Choose the type of event.' },
    occurredAt: { future: 'The date and time cannot be in the future.', before_coverage: 'The event is before your policy starts.', after_coverage: 'The event is after your policy ends.' },
    description: { too_short: 'Tell us what happened (at least 40 characters).', too_long: 'The description is over 600 characters.' }, place: { too_long: 'The place is over 120 characters.' },
    evidence: { none: 'Add at least one photo or video.', too_many: 'A report accepts at most 10 files.', total_size: 'Files cannot exceed 50 MB in total.' } },
  review: { heading: 'Review before sending', next: count => `Review evidence (${count})`, policy: 'Policy', edit: 'Edit', files: (count, megabytes) => `${count} ${count === 1 ? 'file' : 'files'} · ${megabytes} MB`,
    note: 'Sending creates a single case. If the send is interrupted, trying again does not create a new case.', send: 'Send report' },
  sending: { preparing: 'Preparing the files…', creating: 'Creating the report…', uploading: (done, total) => `Sending files (${done} of ${total})…`, submitting: 'Confirming the report…' },
  failures: { unauthorized: 'Your session is not valid. Sign in again.', forbidden: 'Your account cannot report claims.',
    invalid: 'Check the report data and try again.', not_found: 'We did not find that policy. Choose another and try again.',
    outside_coverage: 'The event date is outside your policy period.', conflict: 'The report changed while it was being sent. Review it and send it again.',
    integrity: 'A file changed while it was being sent. Remove it and add it again.', media: 'The service did not accept the type of one of the files.',
    incomplete: missing => `${missing} ${missing === 1 ? 'file is' : 'files are'} still to be received. Your report is not filed yet.`,
    unavailable: 'We could not finish sending. Your report is not filed yet. Try again.', invalid_response: 'The service answered something unexpected. Try again later.' },
  done: { heading: 'Report received', caseNumber: 'Case number', filedAt: 'Filed', evidence: 'Evidence', once: 'One case only: sending again does not create another.', home: 'Back to home' },
  resuming: 'Checking your session…',
  continue: 'Continue', products: { vida_hipotecario: 'Mortgage life', flight_delay: 'Flight delay', weather_event: 'Heavy rain' },
};

export const claimReportMessages: Record<ClaimReportLocale, Copy> = { 'es-CO': es, 'en-US': en };
export type ClaimReportCopy = Copy;
export const issueText = (copy: Copy, issue: Issue): string => (copy.issues[issue.field] as Record<string, string>)[issue.code];
