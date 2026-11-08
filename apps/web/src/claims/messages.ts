export const claimsEs = {
  'claims.open': 'Siniestros', 'claims.nav': 'Siniestros', 'claims.console': 'Consola operativa', 'claims.title': 'Bandeja de siniestros',
  'claims.subtitle': 'Siniestros abiertos · ordenados por prioridad de atención',

  'claims.filterGroup': 'Estado', 'claims.filter.all': 'Todos', 'claims.filter.unassigned': 'Sin asignar', 'claims.filter.pending_information': 'Pendiente info', 'claims.filter.overdue': 'Vencidos',
  'claims.search': 'Buscar por N.º de siniestro o póliza', 'claims.searchButton': 'Buscar', 'claims.searchInvalid': 'Escribe un N.º de siniestro (SIN-AAAA-NNNNN) o el ID de la póliza.',

  'claims.col.claim': 'Siniestro', 'claims.col.policy': 'Póliza', 'claims.col.state': 'Estado', 'claims.col.age': 'Antigüedad', 'claims.col.amount': 'Monto estimado',
  'claims.col.evidence': 'Evidencia', 'claims.col.priority': 'Prioridad',

  'claims.state.unassigned': 'Sin asignar', 'claims.state.in_review': 'En análisis', 'claims.state.pending_information': 'Pendiente de información', 'claims.state.escalated': 'Escalado',
  'claims.state.approved': 'Aprobado', 'claims.state.rejected': 'Rechazado', 'claims.state.paid': 'Pagado',
  'claims.priority.high': 'Alta', 'claims.priority.medium': 'Media', 'claims.priority.low': 'Baja',
  'claims.age': '{days, plural, one {# día} other {# días}}',
  'claims.evidence': '{provided} de {required} · {status}',
  'claims.evidenceStatus.complete': 'completa', 'claims.evidenceStatus.incomplete': 'incompleta', 'claims.evidenceStatus.in_review': 'en revisión',

  'claims.empty': 'No hay siniestros abiertos.', 'claims.emptyFiltered': 'Ningún siniestro coincide con el filtro «{filter}»', 'claims.emptyHint': 'Quita el filtro para ver todos los siniestros abiertos.',
  'claims.clearFilter': 'Quitar filtro', 'claims.next': 'Siguientes',
  'claims.showing': 'Mostrando {count, plural, one {# siniestro} other {# siniestros}}', 'claims.updated': 'Actualizado {time}',

  'claims.loading': 'Consultando siniestros…', 'claims.hidden': 'Vuelve a la ventana para consultar de nuevo.', 'claims.forbidden': 'Tu cuenta no tiene permiso para consultar siniestros.',
  'claims.unauthenticated': 'La sesión venció. Inicia sesión de nuevo.', 'claims.invalid': 'Revisa los criterios de búsqueda.', 'claims.notFound': 'No se encontró la bandeja.',
  'claims.unavailable': 'No se pudo consultar la bandeja de siniestros.', 'claims.retry': 'Reintentar'
};

export const claimsEn: Record<keyof typeof claimsEs, string> = {
  'claims.open': 'Claims', 'claims.nav': 'Claims', 'claims.console': 'Operations console', 'claims.title': 'Claims inbox',
  'claims.subtitle': 'Open claims · sorted by handling priority',

  'claims.filterGroup': 'Status', 'claims.filter.all': 'All', 'claims.filter.unassigned': 'Unassigned', 'claims.filter.pending_information': 'Pending info', 'claims.filter.overdue': 'Overdue',
  'claims.search': 'Search by claim number or policy', 'claims.searchButton': 'Search', 'claims.searchInvalid': 'Enter a claim number (SIN-YYYY-NNNNN) or the policy ID.',

  'claims.col.claim': 'Claim', 'claims.col.policy': 'Policy', 'claims.col.state': 'Status', 'claims.col.age': 'Age', 'claims.col.amount': 'Estimated amount',
  'claims.col.evidence': 'Evidence', 'claims.col.priority': 'Priority',

  'claims.state.unassigned': 'Unassigned', 'claims.state.in_review': 'Under review', 'claims.state.pending_information': 'Pending information', 'claims.state.escalated': 'Escalated',
  'claims.state.approved': 'Approved', 'claims.state.rejected': 'Rejected', 'claims.state.paid': 'Paid',
  'claims.priority.high': 'High', 'claims.priority.medium': 'Medium', 'claims.priority.low': 'Low',
  'claims.age': '{days, plural, one {# day} other {# days}}',
  'claims.evidence': '{provided} of {required} · {status}',
  'claims.evidenceStatus.complete': 'complete', 'claims.evidenceStatus.incomplete': 'incomplete', 'claims.evidenceStatus.in_review': 'under review',

  'claims.empty': 'There are no open claims.', 'claims.emptyFiltered': 'No claim matches the "{filter}" filter', 'claims.emptyHint': 'Clear the filter to see every open claim.',
  'claims.clearFilter': 'Clear filter', 'claims.next': 'Next',
  'claims.showing': 'Showing {count, plural, one {# claim} other {# claims}}', 'claims.updated': 'Updated {time}',

  'claims.loading': 'Loading claims…', 'claims.hidden': 'Return to the window to load again.', 'claims.forbidden': 'Your account is not allowed to view claims.',
  'claims.unauthenticated': 'Your session expired. Sign in again.', 'claims.invalid': 'Check the search criteria.', 'claims.notFound': 'The inbox was not found.',
  'claims.unavailable': 'The claims inbox could not be loaded.', 'claims.retry': 'Retry'
};
