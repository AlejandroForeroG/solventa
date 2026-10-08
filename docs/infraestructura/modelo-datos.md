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

Ejecutar npm run infra:up y npm run test:schema desde la raíz. La prueba crea y elimina
solo su base sintética temporal para validar migraciones desde cero y replay. También
verifica restricciones y rollback de transacciones sintéticas en la base local persistente,
sin borrar datos ni crear fixtures permanentes. CI ejecuta la misma prueba.

El operador aplica node infra/database.mjs provision dev (o staging/prod) desde la revisión
aprobada del ambiente, con credenciales administrativas custodiadas. CD no obtiene estas
credenciales ni ejecuta DDL. Aplicar migraciones aditivas antes de desplegar consumidores
que las necesiten; promover código por PR. Rollback de Workers no revierte tablas.
Nunca editar migraciones registradas. Clúster Basic actual de una región; no se afirma HA.

El checksum nuevo normaliza LF; replay también admite el hash CRLF histórico sin
reescribir el ledger. Cualquier otra modificación falla. Los permisos se reconcilian
por diferencias tras validar todas las tablas; no se usa REVOKE ALL sobre runtime.
CockroachDB puede conservar GRANT/REVOKE pese al rollback. Un fallo intermedio puede
dejar el plan incompleto, pero no elimina los permisos deseados que ya existían; la
reprovisión converge y luego se verifica. Roles con ALL/grant option exigen revisión
administrativa antes de continuar. No se afirma atomicidad de permisos.

schema_migration_failures es una tabla administrativa, sin permisos runtime. El
runner conserva `autocommit_before_ddl=on`, verificado en local y en el clúster Basic.
Cada sentencia DDL puede confirmar por separado; BEGIN/ROLLBACK no hacen atómica
una migración de varias sentencias ni el ledger con ese DDL. Desactivar el ajuste
impide los ALTER actuales sobre tablas con schema_locked en la versión local;
no se cambia globalmente ni se desbloquean tablas automáticamente.
El guard persistente es el mecanismo de protección: cualquier fallo intermedio
puede dejar tablas/constraints parciales y requiere inspección/reconciliación
administrativa, no solo XXA00. No asumir que rollback deshizo el DDL ni volver a
ejecutar la migración completa automáticamente. El
runner guarda allí la intención antes de iniciar DDL y solo la elimina tras confirmar
la transacción. Si falla o se interrumpe, bloquea replay incluso si existe un checksum
en el ledger: CockroachDB puede confirmar DML y fallar ALTER TABLE con XXA00.
El operador debe comprobar SHOW CONSTRAINTS/SHOW CREATE TABLE y el ledger de esa
versión. Si el esquema está completo, conserva el ledger y elimina únicamente su
marca; si está incompleto, reconcilia el DDL y su ledger antes de quitar la marca.
No borrar marcas ni volver a ejecutar automáticamente sin esa inspección. No editar
el SQL registrado para resolverlo. Véase la [limitación oficial de CockroachDB](https://docs.cockroachlabs.com/docs/stable/online-schema-changes#schema-change-ddl-statements-inside-a-multi-statement-transaction-can-fail-while-other-statements-succeed).
