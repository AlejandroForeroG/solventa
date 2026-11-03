export const auditEs = {

  'audit.simulated': 'Proveedores externos simulados', 'audit.title': 'Decisiones de suscripción', 'audit.open': 'Auditoría', 'audit.console': 'Consola operativa',

  'audit.reference': 'ID de decisión, oferta o cotización', 'audit.product': 'Producto', 'audit.outcome': 'Resultado', 'audit.from': 'Desde', 'audit.to': 'Hasta',

  'audit.all': 'Todos', 'audit.search': 'Buscar', 'audit.reset': 'Limpiar', 'audit.next': 'Siguientes', 'audit.back': 'Volver a decisiones',

  'audit.accepted': 'Aceptada', 'audit.declined': 'Rechazada', 'audit.preliminary': 'Preliminar', 'audit.vida_hipotecario': 'Vida hipotecaria', 'audit.flight_delay': 'Retraso de vuelo',

  'audit.decision': 'Decisión', 'audit.date': 'Fecha (Bogotá)', 'audit.rule': 'Regla aplicada', 'audit.version': 'Versión', 'audit.quote': 'Cotización', 'audit.trace': 'Correlación',

  'audit.inputs': 'Entradas de la decisión', 'audit.sources': 'Fuentes de la decisión', 'audit.source': 'Fuente', 'audit.quality': 'Calidad', 'audit.captured': 'Captura', 'audit.degraded': 'Sustitución',
  'audit.inputEvidence': 'Origen de las entradas recuperadas', 'audit.inputField': 'Entrada', 'audit.evidenceReference': 'Registro o artefacto',
  'audit.evidence.retained_profile': 'Perfil conservado', 'audit.evidence.historical_mock': 'Artefacto simulado histórico', 'audit.evidence.offer_revision': 'Revisión de oferta',

  'audit.consent': 'Consentimiento en la decisión', 'audit.historicalConsent': 'Referencia histórica. No acredita un consentimiento vigente.',

  'audit.model': 'Modelo', 'audit.not_used': 'No se utilizó modelo', 'audit.unknown': 'No registrado', 'audit.recorded': 'Registrado',

  'audit.reconstruction': 'Reconstrucción', 'audit.reconstructed': 'Coincide con la regla conservada', 'audit.incomplete_capture': 'Captura histórica incompleta',

  'audit.invalid_capture': 'Captura no válida', 'audit.unsupported_rule': 'Regla sin artefacto disponible', 'audit.unsupported_model': 'Modelo sin artefacto disponible', 'audit.inconsistent_capture': 'Diferencias con el registro histórico',

  'audit.consistencyOnly': 'La comparación verifica consistencia; no certifica la autenticidad del registro.', 'audit.missing': 'Datos faltantes', 'audit.revisions': 'Revisiones de oferta', 'audit.premium': 'Prima',

  'audit.export': 'Exportar JSON', 'audit.exporting': 'Exportando…', 'audit.exported': 'Descarga iniciada', 'audit.empty': 'No hay decisiones para estos filtros.',

  'audit.loading': 'Consultando decisiones…', 'audit.forbidden': 'Tu cuenta no tiene permiso de auditoría.', 'audit.unauthenticated': 'La sesión venció. Inicia sesión de nuevo.',

  'audit.notFound': 'No se encontró la decisión.', 'audit.invalid': 'Revisa los filtros de búsqueda.', 'audit.unavailable': 'No se pudo consultar la auditoría.', 'audit.retry': 'Reintentar',

  'audit.yes': 'Sí', 'audit.no': 'No', 'audit.verified': 'Verificado', 'audit.not_required': 'No requerido', 'audit.mock': 'Simulada', 'audit.live': 'Original', 'audit.stored_copy': 'Copia conservada', 'audit.default': 'Valor de respaldo',

  'audit.confidence': 'Confianza', 'audit.hidden': 'Vuelve a la ventana para consultar de nuevo.',

  'audit.input.amount': 'Monto (COP)', 'audit.input.termMonths': 'Plazo (meses)', 'audit.input.ageYears': 'Edad (años)', 'audit.input.monthlyIncomeCop': 'Ingresos mensuales (COP)',

  'audit.input.monthlyObligationsCop': 'Obligaciones mensuales (COP)', 'audit.input.paymentScore': 'Puntaje de pago', 'audit.input.identityVerified': 'Identidad verificada', 'audit.input.affiliationActive': 'Afiliación activa',

  'audit.input.debtRatioPpm': 'Relación de deuda (ppm)', 'audit.input.adjustmentPpm': 'Ajuste (ppm)', 'audit.input.baseRatePpm': 'Tasa base (ppm)', 'audit.input.baseRuleVersion': 'Regla de tarifa base',

  'audit.check.amountWithinLimit': 'Monto dentro del límite', 'audit.check.identityVerified': 'Identidad verificada', 'audit.check.affiliationActive': 'Afiliación activa', 'audit.check.paymentScoreSufficient': 'Puntaje mínimo de 600', 'audit.check.debtRatioWithinLimit': 'Relación de deuda máxima del 50 %', 'audit.check.discountApplied': 'Descuento aplicado',

  'audit.flightReference': 'Referencia de vuelo', 'audit.offer': 'Oferta', 'audit.input.flightReference': 'Referencia de vuelo', 'audit.input.scheduleAvailable': 'Vuelo disponible',
  'audit.input.premium': 'Prima (COP)', 'audit.input.payoutAmount': 'Indemnización (COP)', 'audit.input.thresholdMinutes': 'Umbral (minutos)'

};

export const auditEn: Record<keyof typeof auditEs, string> = {

  'audit.simulated': 'Simulated external providers', 'audit.title': 'Underwriting decisions', 'audit.open': 'Audit', 'audit.console': 'Operations console',

  'audit.reference': 'Decision, offer or quote ID', 'audit.product': 'Product', 'audit.outcome': 'Outcome', 'audit.from': 'From', 'audit.to': 'To',

  'audit.all': 'All', 'audit.search': 'Search', 'audit.reset': 'Clear', 'audit.next': 'Next', 'audit.back': 'Back to decisions',

  'audit.accepted': 'Accepted', 'audit.declined': 'Declined', 'audit.preliminary': 'Preliminary', 'audit.vida_hipotecario': 'Mortgage life', 'audit.flight_delay': 'Flight delay',

  'audit.decision': 'Decision', 'audit.date': 'Date (Bogotá)', 'audit.rule': 'Applied rule', 'audit.version': 'Version', 'audit.quote': 'Quote', 'audit.trace': 'Correlation',

  'audit.inputs': 'Decision inputs', 'audit.sources': 'Decision sources', 'audit.source': 'Source', 'audit.quality': 'Quality', 'audit.captured': 'Captured', 'audit.degraded': 'Substitution',
  'audit.inputEvidence': 'Recovered input provenance', 'audit.inputField': 'Input', 'audit.evidenceReference': 'Record or artifact',
  'audit.evidence.retained_profile': 'Retained profile', 'audit.evidence.historical_mock': 'Historical mock artifact', 'audit.evidence.offer_revision': 'Offer revision',

  'audit.consent': 'Consent at decision time', 'audit.historicalConsent': 'Historical reference. It does not establish current consent.',

  'audit.model': 'Model', 'audit.not_used': 'No model was used', 'audit.unknown': 'Not recorded', 'audit.recorded': 'Recorded',

  'audit.reconstruction': 'Reconstruction', 'audit.reconstructed': 'Matches the retained rule', 'audit.incomplete_capture': 'Incomplete historical capture',

  'audit.invalid_capture': 'Invalid capture', 'audit.unsupported_rule': 'Rule artifact unavailable', 'audit.unsupported_model': 'Model artifact unavailable', 'audit.inconsistent_capture': 'Differences from the historical record',

  'audit.consistencyOnly': 'This comparison checks consistency; it does not certify record authenticity.', 'audit.missing': 'Missing data', 'audit.revisions': 'Offer revisions', 'audit.premium': 'Premium',

  'audit.export': 'Export JSON', 'audit.exporting': 'Exporting…', 'audit.exported': 'Download started', 'audit.empty': 'No decisions match these filters.',

  'audit.loading': 'Loading decisions…', 'audit.forbidden': 'Your account does not have audit permission.', 'audit.unauthenticated': 'Your session expired. Sign in again.',

  'audit.notFound': 'Decision not found.', 'audit.invalid': 'Check the search filters.', 'audit.unavailable': 'Audit could not be loaded.', 'audit.retry': 'Retry',

  'audit.yes': 'Yes', 'audit.no': 'No', 'audit.verified': 'Verified', 'audit.not_required': 'Not required', 'audit.mock': 'Simulated', 'audit.live': 'Original', 'audit.stored_copy': 'Retained copy', 'audit.default': 'Fallback value',

  'audit.confidence': 'Confidence', 'audit.hidden': 'Return to the window to query again.',

  'audit.input.amount': 'Amount (COP)', 'audit.input.termMonths': 'Term (months)', 'audit.input.ageYears': 'Age (years)', 'audit.input.monthlyIncomeCop': 'Monthly income (COP)',

  'audit.input.monthlyObligationsCop': 'Monthly obligations (COP)', 'audit.input.paymentScore': 'Payment score', 'audit.input.identityVerified': 'Identity verified', 'audit.input.affiliationActive': 'Affiliation active',

  'audit.input.debtRatioPpm': 'Debt ratio (ppm)', 'audit.input.adjustmentPpm': 'Adjustment (ppm)', 'audit.input.baseRatePpm': 'Base rate (ppm)', 'audit.input.baseRuleVersion': 'Base rating rule',

  'audit.check.amountWithinLimit': 'Amount within limit', 'audit.check.identityVerified': 'Identity verified', 'audit.check.affiliationActive': 'Affiliation active', 'audit.check.paymentScoreSufficient': 'Minimum payment score of 600', 'audit.check.debtRatioWithinLimit': 'Maximum debt ratio of 50%', 'audit.check.discountApplied': 'Discount applied',

  'audit.flightReference': 'Flight reference', 'audit.offer': 'Offer', 'audit.input.flightReference': 'Flight reference', 'audit.input.scheduleAvailable': 'Flight available',
  'audit.input.premium': 'Premium (COP)', 'audit.input.payoutAmount': 'Payout (COP)', 'audit.input.thresholdMinutes': 'Threshold (minutes)'

};
