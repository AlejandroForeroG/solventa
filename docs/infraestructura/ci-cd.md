# Gitflow y promoción por PR

Cada rama base nace de `origin/staging`: `feat/<descripcion>`, `fix/<descripcion>`, `refactor/<descripcion>` o `test/<descripcion>`, en minúsculas y con guiones. Crear desde ella una rama con el mismo nombre y sufijo `-dev`, por ejemplo `feat/cotizacion-dev`. El límite es 72 caracteres para cualquier rama; reservar cuatro para el sufijo (base de hasta 68). Commits y títulos de PR: `feat|fix|refactor|test(modulo): descripción`, máximo 150 caracteres en la primera línea. `npm ci` activa hooks nativos; CI vuelve a validar origen, destino y título del PR.

El [diagrama completo en Lucidchart](https://lucid.app/lucidchart/1d00d2c4-f0fe-40a9-934b-d1cc4a2ea8e0/edit) muestra el origen en staging, la rama base, su rama de integración, el retorno de correcciones, dev y el release a prod.

## 1. Crear y desarrollar la rama base

```sh
git fetch origin
git switch -c feat/cotizacion origin/staging
```

Implementar y probar la feature, actualizar la documentación existente del módulo y guardar commits coherentes en esta base. Consultar [pruebas](../pruebas.md), [endpoints](../estandares-endpoints.md) y [migraciones](migraciones.md) según el cambio. La base conserva únicamente el cambio destinado a staging.

## 2. Validar por una rama de integración en dev

Después de tener el cambio en la base:

```sh
git switch -c feat/cotizacion-dev feat/cotizacion
git merge --no-ff -m "refactor(ci): integrar dev para probar cotizacion" origin/dev
git push -u origin feat/cotizacion
git push -u origin feat/cotizacion-dev
```

Resolver los conflictos de integración en `feat/cotizacion-dev`. Abrir PR **`feat/cotizacion-dev` → `dev`** con enlaces a las guías creadas/actualizadas en esa rama y resultados de las pruebas. CI comprueba política, arquitectura, pruebas, lint, tipos, builds y SQL/RPC local con TLS. Integrar mediante merge normal después de checks verdes. Deploy repite CI, publica los cuatro Workers de dev y comprueba SQL/RPC y aislamiento. Validar el flujo real en dev.

Si se corrige funcionalidad en la rama `-dev`, llevar sus commits pertinentes a la base mediante cherry-pick; no copiar merges ni trabajo ajeno de dev:

```sh
git switch feat/cotizacion
git cherry-pick <sha-del-fix>
git push
git switch feat/cotizacion-dev
git merge --no-ff -m "fix(ci): sincronizar correccion de la rama base" feat/cotizacion
git push
```

Una resolución exclusiva de integración puede permanecer en `-dev`; cualquier corrección necesaria para la feature debe llegar a la base. Sincronizar siempre la base de nuevo en `-dev`: cherry-pick produce otro SHA y CI comprueba ascendencia, además del contenido. Abrir otro PR de `-dev` a dev y esperar CI/Deploy exitosos para esa revisión. No fusionar dev en la base.

## 3. Promover la base lista a staging

Abrir PR **`feat/cotizacion` → `staging`** cuando su comportamiento esté validado. Enlazar las guías de la rama base y el Deploy de dev que contiene la revisión actual de `feat/cotizacion-dev`. Dev puede contener otras features: staging recibe solamente esta base.

El gate comprueba que:

- El SHA actual de la base es ancestro del SHA actual de su rama remota `<base>-dev`.
- Ese SHA de integración es ancestro de un Deploy exitoso de dev y su árbol coincide con el desplegado. La ascendencia sola no basta: un descendiente que revierte o sobrescribe el contenido no acredita esa prueba. Sincronizar la rama de integración con dev antes de integrar si avanzó.
- El árbol del merge candidato a staging coincide con el árbol de la base.

Si staging avanzó, actualizar la base desde `origin/staging` mediante merge normal, resolver ahí la compatibilidad del candidato y sincronizarla en `-dev`. Repetir pruebas y PR/Deploy en dev antes de promover; no aprobar un resultado combinado que no se haya probado. El gate no acredita por sí solo pruebas de aceptación de negocio.

Conservar las dos ramas remotas hasta completar la promoción. Usar **merge normal** en estos PR, incluido `-dev` a dev: squash/rebase elimina la ascendencia necesaria para acreditar el despliegue. No borrar la rama `-dev` automáticamente tras integrar su primer PR. No utilizar Update branch si eso incorporaría dev en la base.

## 4. Publicar un release de staging a prod

Deploy de staging vuelve a ejecutar CI, publica staging y valida infraestructura. Probar el candidato y abrir PR **`staging` → `prod`** para cada release. Enlazar el Deploy exitoso del SHA exacto de staging, las guías del release y sus comprobaciones. CI exige ese despliegue y que el merge mantenga el árbol de origen. Integrar con merge normal y esperar Deploy exitoso de prod.

Si se necesita incorporar historia de un merge de prod de vuelta a staging, usar una rama de mantenimiento nacida de staging y su pareja `-dev`, siguiendo el mismo recorrido. No hacer pushes directos ni copiar el conjunto de cambios de dev. `main` queda como referencia histórica sin despliegue.

## Protecciones y documentación del PR

Las tres ramas requieren PR, checks `policy` y `validate`, rama actualizada y conversaciones resueltas; aplica también a administradores. Dev no exige aprobación humana. Staging/prod normalmente requieren una aprobación. Una excepción explícitamente autorizada solo afecta la promoción solicitada: mantener CI y restaurar el requisito temporal de aprobación.

Cada PR espera la revisión de Codex antes de integrarse. Comprobar su finalización real sobre el SHA actual del PR: un disparo, estado Running, CI verde o revisión de una versión anterior no bastan. Resolver los hallazgos corregibles dentro del alcance, actualizar pruebas/documentación y obtener revisión de la versión final. Si un hallazgo es ambiguo, no puede resolverse o requiere una decisión de producto/cambio de alcance, explicarlo al usuario y esperar su respuesta antes de integrar. No descartar hallazgos para desbloquear el merge. Esta revisión no sustituye CI ni la aprobación humana cuando sea exigida.

Usar la [plantilla de PR](../../.github/pull_request_template.md). Cada PR enlaza sus documentos nuevos o actualizados mediante URLs de GitHub a los archivos en su rama de origen, y explica cambio, pruebas ejecutadas y límites. Una corrección interna sin impacto documental debe justificarlo; una feature siempre incluye documentación. No crear copias de una guía por rama o ambiente. Los mensajes no seleccionan ambientes: lo hace la rama de destino.

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

El [procedimiento de migraciones](migraciones.md) es la referencia única para crear SQL, validar permisos, aplicar el candidato aprobado antes de integrar y reconciliar fallos. CD solo usa roles runtime: comprueba el esquema antes de publicar y nunca recibe credenciales administrativas ni aplica DDL remoto.

Deploy no hace rollback automático si falla una comprobación posterior. Preparar una revisión compatible mediante el mismo Gitflow y verificarla antes de promover. Un rollback del Worker no revierte SQL ni datos; conservar migraciones/checksums y seguir la recuperación de esa guía.
