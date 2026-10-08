# Desarrollo y promoción por PR

Rama de trabajo: `feat/<descripcion>`, `fix/<descripcion>`, `refactor/<descripcion>` o `test/<descripcion>` desde `dev`, en minúsculas y con guiones. La descripción resume el cambio, como `feat/agregar-login`. Commits y títulos de PR: `feat|fix|refactor|test(modulo): descripción`, máximo 150 caracteres en la primera línea. `npm ci` activa los hooks nativos: pre-commit/pre-push validan rama y commit-msg valida el mensaje. CI vuelve a validar el título y origen del PR para cubrir cambios hechos sin hooks.

## Flujo

1. Implementar y probar en local; abrir PR desde una rama de trabajo hacia `dev`.
2. CI valida política, arquitectura, pruebas, lint, tipos, builds y SQL/RPC local con TLS. Cada PR requiere checks verdes y revisión de Codex terminada para su commit actual antes de integrar; dev no necesita revisión humana.
3. Al integrar en `dev`, Deploy repite CI, despliega los cuatro Workers de dev y verifica SQL, RPC y aislamiento.
4. Probar el flujo real en dev; abrir PR `dev` → `staging`. CI exige que el commit de origen tenga un Deploy exitoso y que el árbol resultante coincida con el origen. Integrar con merge normal.
5. Al integrar en `staging`, se ejecuta CI y despliegue de staging. Probar el candidato y abrir PR `staging` → `prod` con el mismo control de despliegue previo y contenido. Integrar con merge normal.
6. Al integrar en `prod`, CI y Deploy publican y verifican producción. Revisar la ejecución y los flujos del producto.

Las tres ramas de ambientes requieren PR, checks `policy`, `validate` y `codex-review` con la rama actualizada y resolución de conversaciones; aplican también a administradores. Dev no exige aprobación humana. Staging y prod requieren una aprobación antes de integrar. No hacer pushes directos. La validación humana de negocio se documenta en el PR de promoción y la revisión. El control automático acredita el despliegue previo, no todos los criterios funcionales.

Los merge commits cambian el SHA entre ambientes; se conserva el contenido del candidato, comprobado con git diff en el PR de promoción. No usar squash ni rebase entre ambientes, ni agregar cambios específicos en staging/prod. Squash se admite al integrar una feature en dev. `main` queda como referencia histórica, sin despliegue.

Con protección de rama actualizada, los commits de integración de staging/prod deben
volver a dev antes de la siguiente promoción. Crear `feat/sync-staging` o
`feat/sync-prod` desde dev, integrar la rama del ambiente con merge normal y abrir
PR hacia dev con CI. Integrar ese PR también con merge normal, nunca squash/rebase,
para conservar la ascendencia. Después promover dev a staging y staging a prod.
Usar un mensaje compatible con el hook, por ejemplo
`git merge --no-ff -m "fix(ci): sincronizar staging en dev" origin/staging`
en la rama `feat/sync-staging`; para prod sustituir el ambiente en ambos lugares.
No usar Update branch para empujar directamente a una rama protegida. Resolver
conflictos en la rama de trabajo; el gate sigue exigiendo el contenido del origen.

PR sugerido: `feat(identity): registrar sesión principal`. Promoción: `refactor(ci): promover dev a staging` y `refactor(ci): promover staging a prod`. Describir resultado de pruebas, ejecución de Deploy, limitaciones y compatibilidad SQL. Los mensajes no seleccionan ambientes: lo hace la rama de destino.

## Configuración de GitHub

En el repositorio, ir a **Settings > Environments**. Los ambientes `dev`, `staging` y `prod` están creados. En cada uno configurar:

| Tipo | Nombre | Valor |
|---|---|---|
| Variable | DATABASE_HOST | Host del clúster CockroachDB |
| Variable | DATABASE_PORT | Puerto SQL, normalmente 26257 |
| Secret | DATABASE_CA_PEM | Contenido completo del bundle CA público del clúster |
| Secret | RUNTIME_STATE_JSON | Contenido de infra/.local/runtime.<ambiente>.json |
| Secret | WEB_INFRA_TOKEN | Valor DEV_INFRA_TOKEN de infra/.local/web.<ambiente>.secrets.json |
| Secret | IDENTITY_AUTH_JSON | Configuración custodiada de Identidad para ese ambiente; ver [autenticación](../modulos/identity-consent-ecosystem/autenticacion.md) |
| Secret | CLOUDFLARE_API_TOKEN | Token de despliegue de la cuenta configurada |

Los valores runtime y web pertenecen al ambiente y deben conservar las credenciales provisionadas. No colocar una URL administrativa, contraseña root ni certificados cliente en GitHub. CD usa las credenciales runtime para comprobar SQL y la API de Cloudflare para publicar. El ID de cuenta permanece fijo en las configuraciones.

Crear un token de Cloudflare limitado a la cuenta configurada, con **Workers Scripts: Edit**, **Workers Tail: Read**, **Account Settings: Read**, **Hyperdrive: Read** y **Account: SSL and Certificates: Read**. El flujo no necesita Hyperdrive Edit, rutas de zonas ni permiso para crear certificados. Workers Tail Read corresponde a los permisos habituales de publicación Wrangler. La autorización sobre Workers Scripts abarca la cuenta, por lo que la selección de ambiente también depende de los controles del repositorio y los bindings verificados.

Las políticas de GitHub environments permiten exclusivamente su rama homónima: dev, staging o prod. Los PR no reciben credenciales remotas; solo el job de Deploy posterior a CI las restaura. Los secretos se limpian siempre al terminar. Todos los recursos deben estar aprovisionados antes de integrar cambios que los necesiten.

El token Workers Scripts a nivel de cuenta puede modificar Workers de otros
ambientes. Las ramas/environments no limitan ese alcance dentro de Cloudflare:
código integrado en dev recibe un token que podría publicar sobre prod. Esta base
presupone colaboradores de confianza y no contiene usuarios reales. Antes de
habilitar datos reales, definir aislamiento mediante cuentas Cloudflare separadas
o revisión obligatoria de los cambios ejecutables de infraestructura/CI. Tokens
distintos con el mismo alcance de cuenta no resuelven por sí solos este límite.

## Migraciones y recuperación

Las migraciones siguen a cargo del operador por ambiente, antes de desplegar código que dependa de ellas. Un cambio solo de código no requiere reprovisionar Hyperdrive. El despliegue no hace rollback automático si falla una comprobación posterior. Para recuperar, preparar una reversión en una rama de trabajo, pasar por PR y promoverla; verificar compatibilidad con datos y migraciones existentes. Nunca restaurar credenciales administrativas en Actions.

CD ejecuta `infra:<ambiente>:schema-verify` antes de publicar: compara versiones,
checksums, catálogo, lecturas y permisos DML efectivos con la revisión desplegada usando roles
runtime. Un ambiente que siga en baseline no puede obtener Deploy exitoso de esta
revisión. Tras aprobar el candidato, el operador debe aplicar sus migraciones antes
de integrar y ejecutar `node infra/schema-verify.mjs <ambiente> --admin` con su
configuración custodiada. Este paso también confirma public vacío y guardas sin
marcas pendientes. Antes de migrar, inspeccionar el catálogo y ledger con una
conexión administrativa READ ONLY; si existe schema_migration_failures, consultar
`SELECT version, checksum, error_code FROM <esquema>.schema_migration_failures` por
propietario. No quitar marcas sin reconciliar. La verificación runtime no reemplaza
este control administrativo ni recibe esas credenciales en CD.

## Revisión obligatoria de Codex

El check `codex-review` espera hasta 12 minutos por el resumen Completed publicado por el bot oficial para el SHA actual del PR. No acepta revisiones de commits anteriores, otro autor, revisión de seguridad ni estados Running/Failed. Un rechazo formal de Codex bloquea el check; GitHub exige además resolver las conversaciones. El job no usa secretos de ambientes ni despliega. Deploy vuelve a ejecutar las pruebas tras el merge; la revisión se exige antes de integrar el PR.

Si Codex falla, agota su cuota o no termina, el check falla y el PR permanece bloqueado. Solicitar `@codex review` y volver a ejecutar el check fallido cuando termine. Después de subir correcciones, solicitar una nueva revisión del commit actual: la configuración de Codex revisa automáticamente al abrir el PR. No saltarse el check ni reutilizar la revisión anterior. El reconocimiento del resumen depende del formato actual del conector; un cambio de formato falla de forma cerrada y requiere actualizar el parser y sus pruebas.

El job ejecuta el gate desde el commit inmutable `506a62f876376e2d3a0734b54ffb43be9afca592`, no desde el código propuesto por el PR. Para actualizar el gate, revisar su implementación primero y después actualizar el SHA fijado del workflow mediante otro PR. Los cambios a workflows siguen formando parte de la frontera de confianza de los colaboradores del repositorio.

El SHA abreviado del resumen se resuelve mediante la API de commits y se compara con los 40 caracteres del head; un prefijo ambiguo falla. Las lecturas reintentan errores de red, timeout, 429 y 5xx transitorios hasta tres intentos con backoff; errores de permisos, configuración y SHA ambiguo fallan sin reintentar.
