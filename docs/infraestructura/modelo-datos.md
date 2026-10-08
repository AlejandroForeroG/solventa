# Modelo SQL base

Las migraciones implementan los agregados de la arquitectura con UUID, timestamps,
versiones y restricciones locales. Los nombres SQL, tipos y estados iniciales son
decisiones de implementación del modelo conceptual. Las máquinas de estado y la
autorización por usuario se completan en los casos de uso.

| Propietario | Tablas de negocio |
|---|---|
| identity | clients, external_identities, authentication_sessions, partners, partner_credentials, consents, registered_devices |
| acquisition | quotes, risk_profiles, underwriting_decisions, offers, offer_revisions, signal_refresh_jobs |
| policy | policies, claims, indemnities, payments, evidence_metadata |

Cada propietario añade audit_events, outbox_events e inbox_events: 27 tablas, además
de tres registros administrativos schema_migrations. No hay FK entre esquemas;
referencias externas se validan por contrato o evento, nunca por consulta a tablas ajenas.

## Datos por módulo

- [Identidad y consentimiento](../modulos/identity-consent-ecosystem/datos.md).
- [Adquisición, riesgo e historia de ofertas](../modulos/acquisition-risk/datos.md).
- [Pólizas, dinero y evidencia](../modulos/policy-claims-payments/datos.md).

## Eventos y permisos

Confirmar resultado, auditoría y outbox en una transacción local. Outbox mantiene lease,
intentos y disponibilidad; solo marcar published tras confirmar transporte. Confirmar
efecto e inbox juntos; UNIQUE(event_id, consumer) deduplica por consumidor. Handlers,
Queues, reintentos, DLQ y reconciliación aún requieren implementación.

runtime-grants.json enumera tablas/privilegios propios: sin DELETE, DDL, acceso cruzado
o escritura del ledger. Auditoría e inbox son append-only para runtime. Retención y
mantenimiento requieren un operador administrativo. Estos permisos aíslan backends;
no sustituyen la autorización por usuario ni su consentimiento.

## Operación

Seguir [crear, aplicar y recuperar migraciones](migraciones.md) para SQL nuevo, permisos, pruebas locales, aplicación administrativa por ambiente y reconciliación de DDL/guardas. El procedimiento incluye instalación desde cero y replay, checksums, grants no atómicos y compatibilidad del rollback de Workers. El modelo de datos no duplica esas instrucciones.

El clúster Basic actual tiene una región; no se afirma alta disponibilidad.
