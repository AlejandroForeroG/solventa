# Operación de infraestructura

## Local

Requiere Node 22.21.1, npm 10.9.4 y Docker con Compose. Desde la raíz:

```sh
npm ci
npm run infra:up
npm run check
npm run test:infra
npm run dev:backend
```

Compose usa CockroachDB 26.2.0, un nodo y un volumen persistente. Un proceso inicial genera CA y certificados; el nodo y los clientes verifican TLS. Solo se publican `127.0.0.1:26258` (SQL) y `127.0.0.1:8088` (consola HTTPS). La consola usa la CA local y requiere credenciales administrativas. `infra:up` puede repetirse: aplica migraciones pendientes y conserva contraseñas y datos.

`infra:down` detiene contenedores sin borrar el volumen. Certificados, contraseñas, configuraciones locales Wrangler y token de diagnóstico están ignorados por Git. Conservar `infra/.local` junto al volumen; perder las contraseñas exige recuperación administrativa. No compartir estos archivos ni usarlos en producción.

La base `solventa_local` tiene tres propietarios lógicos:

| Backend | Esquema | Binding |
|---|---|---|
| acquisition-risk | acquisition | ACQUISITION_DB |
| identity-consent-ecosystem | identity | IDENTITY_DB |
| policy-claims-payments | policy | POLICY_DB |

Cada rol runtime puede leer su registro de migraciones; no puede consultar los demás esquemas ni crear tablas. El aprovisionador utiliza una conexión administrativa separada. Las futuras migraciones deben otorgar explícitamente el DML mínimo de sus tablas al rol propio; nunca DDL ni privilegios sobre otro propietario. `infra:verify` comprueba permisos con consultas reales.

Cada backend mantiene sus SQL en `migrations/`. El registro conserva versión, checksum y fecha; modificar una migración aplicada produce un error. La inicial fija la línea base con `SELECT 1`; las posteriores crean las [26 tablas base](data-model.md). Ejecutar `npm run test:schema` para verificar migraciones, permisos y restricciones en SQL local real.

`test:infra` inicia temporalmente cuatro Workers en 8790 y verifica SQL, RPC, rechazo de tokens ausentes o inválidos, activos web y rutas de negocio deshabilitadas. El token local se genera en `apps/web/.dev.vars`; no se imprime. `/health` es liveness; `GET /internal/infra` exige `Authorization: Bearer <DEV_INFRA_TOKEN>` y devuelve 503 si una dependencia no está disponible.

## Cloudflare y CockroachDB: dev, staging y prod

La cuenta configurada es `803fd559877aae8f638140610f106857`. El perfil Wrangler esperado es `solventa-universidad`; puede seleccionarse otro perfil autorizado mediante `CLOUDFLARE_PROFILE`, pero la cuenta destino permanece fija. Autenticarse con `wrangler login --profile solventa-universidad`.

Cada ambiente lee exclusivamente su archivo local ignorado `.env.infra.dev`, `.env.infra.staging` o `.env.infra.prod`, con `DATABASE_URL` de una conexión administrativa y `DATABASE_CA_FILE` de la CA del clúster. Esta CA pública se registra en Cloudflare para verificar el origen. No copiar certificados cliente ni credenciales del entorno local. El aprovisionador usa la URL administrativa para crear la base correspondiente, esquemas y roles. Nunca hereda variables de otro archivo ni utiliza un ambiente remoto por defecto. No crea ni cambia el plan del clúster.

| Ambiente | Base | Workers | Hyperdrives | Uso |
|---|---|---|---|---|
| dev | solventa_dev | 4 | 3 | Integración durante desarrollo |
| staging | solventa_staging | 4 | 3 | Validar una versión candidata |
| prod | solventa_prod | 4 | 3 | Base del despliegue final |

Los tres ambientes comparten actualmente un clúster CockroachDB Basic. Cada base revoca acceso público y cada rol `solventa_<ambiente>_<propietario>` tiene privilegios solo sobre su esquema. Workers, bindings, usuarios SQL y secretos de diagnóstico pertenecen a un ambiente. La CA pública puede reutilizarse porque verifica el mismo origen. Mantener un clúster común implica recursos y fallos compartidos.

Cada ambiente tiene un aprovisionador designado. Los demás desarrolladores usan su entorno local y no necesitan credenciales administrativas. El aprovisionador custodia una copia cifrada, fuera de Git, de `infra/.local/runtime.<ambiente>.json` y `infra/.local/web.<ambiente>.secrets.json` mediante el almacén de secretos autorizado del equipo. Git no es una copia de seguridad de esos archivos.

Para cambiar de máquina o incorporar otro operador, restaurar los dos archivos del ambiente bajo `infra/.local` con acceso limitado al usuario antes de ejecutar los comandos. Si los usuarios SQL ya existen y falta el estado, el preflight devuelve `runtime_state_missing` antes de modificar la base o los Hyperdrives. Si el Worker web ya tiene el secreto y falta su archivo, el despliegue devuelve `web_state_missing` antes de publicar Workers. Recuperar el estado original desde custodia y repetir. Si se perdió definitivamente, requiere recuperación administrativa coordinada: rotar los tres usuarios y actualizar sus Hyperdrives juntos, además del secreto de diagnóstico si se perdió. El script no hace esa rotación automáticamente. No ejecutar aprovisionadores concurrentes sobre el mismo ambiente.

```sh
npm run infra:dev:up
npm run deploy:dev
npm run infra:dev:verify

npm run infra:staging:up
npm run deploy:staging
npm run infra:staging:verify

npm run infra:prod:up
npm run deploy:prod
npm run infra:prod:verify
```

`infra:<ambiente>:up` aplica migraciones, comprueba aislamiento, crea o actualiza exclusivamente los Hyperdrives de ese entorno y guarda sus IDs en su configuración. Cada Hyperdrive usa su rol propio, caché deshabilitada, TLS `verify-full` y límite de cinco conexiones al origen. El aprovisionador no imprime URL, contraseñas ni token de Cloudflare. Las credenciales administrativas nunca se enlazan a un Worker. Antes de una mutación, la validación rechaza bindings cruzados, IDs compartidos y backends públicos.

El despliegue publica primero Identidad y Pólizas, después Adquisición y finalmente web. Genera un secreto aleatorio propio persistido en `infra/.local/web.<ambiente>.secrets.json` y lo sube con `--secrets-file`. Aunque la variable conserva el nombre `DEV_INFRA_TOKEN`, su valor es distinto para cada ambiente. Los backends tienen `workers_dev: false` y `preview_urls: false`. Solo web tiene dirección pública: activos y liveness son públicos y el diagnóstico exige el secreto. Las rutas de negocio están cerradas. La dirección se registra localmente en `infra/.local/<ambiente>-endpoint.json`.

La comprobación remota valida configuración Hyperdrive, SQL vía Workers, RPC, permisos del diagnóstico y exposición privada de backends. También exige que los tres servicios informen el ambiente y nombre de base correctos. `infra:<ambiente>:verify` comprueba lecturas SQL denegadas hacia los otros esquemas y las otras dos bases remotas, por lo que las tres bases deben existir. No mide latencia, resiliencia, alertas, cumplimiento PCI ni seguridad integral.

CI valida código, empaquetado de los doce Workers y entorno local sin credenciales de despliegue. CD reutiliza esas comprobaciones antes de publicar los cuatro Workers del ambiente seleccionado, verifica SQL/RPC y limpia los archivos sensibles del runner. Ver [configuración de CI/CD](ci-cd.md). Para promover una versión, usar el mismo commit validado en dev, desplegarlo en staging y comprobar sus flujos antes de prod. Aprovisionar cada ambiente por separado para aplicar sus migraciones desde el operador administrativo. CD restaura credenciales runtime y nunca crea usuarios SQL ni aplica migraciones con privilegios administrativos. No copiar datos, secretos ni IDs al promover código. Un rollback de Worker no revierte SQL ni datos. Conservar las migraciones aplicadas y su checksum.

El ambiente prod inicial solo ofrece activos, liveness y diagnóstico protegido. Las funcionalidades, autenticación de usuarios, tratamiento de PII, recuperación y alertas requieren implementación y validación antes de habilitar el producto para usuarios reales.

Referencias: [ambientes Wrangler](https://developers.cloudflare.com/workers/wrangler/environments/), [Hyperdrive y TLS](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/), [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [secretos](https://developers.cloudflare.com/workers/configuration/secrets/).
