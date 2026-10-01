# Desarrollo y promoción por PR

Rama de trabajo: `feat/<caso-o-ticket>` desde `dev`. Commits y títulos de PR: `feat|fix|refactor|test(modulo): mensaje`, máximo 72 caracteres en la primera línea. `npm ci` activa los hooks nativos: pre-commit/pre-push validan rama y commit-msg valida el mensaje. CI vuelve a validar el título y origen del PR para cubrir cambios hechos sin hooks.

## Flujo

1. Implementar y probar en local; abrir PR `feat/*` → `dev`.
2. CI valida política, arquitectura, pruebas, lint, tipos, builds y SQL/RPC local con TLS. El PR hacia dev requiere checks verdes antes de integrar; no necesita revisión humana.
3. Al integrar en `dev`, Deploy repite CI, despliega los cuatro Workers de dev y verifica SQL, RPC y aislamiento.
4. Probar el flujo real en dev; abrir PR `dev` → `staging`. CI exige que el commit de origen tenga un Deploy exitoso y que el árbol resultante coincida con el origen. Integrar con merge normal.
5. Al integrar en `staging`, se ejecuta CI y despliegue de staging. Probar el candidato y abrir PR `staging` → `prod` con el mismo control de despliegue previo y contenido. Integrar con merge normal.
6. Al integrar en `prod`, CI y Deploy publican y verifican producción. Revisar la ejecución y los flujos del producto.

Las tres ramas de ambientes requieren PR, checks `policy` y `validate` con la rama actualizada y resolución de conversaciones; aplican también a administradores. Dev no exige aprobación humana. Staging y prod requieren una aprobación antes de integrar. No hacer pushes directos. La validación humana de negocio se documenta en el PR de promoción y la revisión. El control automático acredita el despliegue previo, no todos los criterios funcionales.

Los merge commits cambian el SHA entre ambientes; se conserva el contenido del candidato, comprobado con git diff en el PR de promoción. No usar squash ni rebase entre ambientes, ni agregar cambios específicos en staging/prod. Squash se admite al integrar una feature en dev. `main` queda como referencia histórica, sin despliegue.

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
| Secret | CLOUDFLARE_API_TOKEN | Token de despliegue de la cuenta configurada |

Los valores runtime y web pertenecen al ambiente y deben conservar las credenciales provisionadas. No colocar una URL administrativa, contraseña root ni certificados cliente en GitHub. CD usa las credenciales runtime para comprobar SQL y la API de Cloudflare para publicar. El ID de cuenta permanece fijo en las configuraciones.

Crear un token de Cloudflare limitado a la cuenta configurada, con **Workers Scripts: Edit**, **Workers Tail: Read**, **Account Settings: Read**, **Hyperdrive: Read** y **Account: SSL and Certificates: Read**. El flujo no necesita Hyperdrive Edit, rutas de zonas ni permiso para crear certificados. Workers Tail Read corresponde a los permisos habituales de publicación Wrangler. La autorización sobre Workers Scripts abarca la cuenta, por lo que la selección de ambiente también depende de los controles del repositorio y los bindings verificados.

Las políticas de GitHub environments permiten exclusivamente su rama homónima: dev, staging o prod. Los PR no reciben credenciales remotas; solo el job de Deploy posterior a CI las restaura. Los secretos se limpian siempre al terminar. Todos los recursos deben estar aprovisionados antes de integrar cambios que los necesiten.

## Migraciones y recuperación

Las migraciones siguen a cargo del operador por ambiente, antes de desplegar código que dependa de ellas. Un cambio solo de código no requiere reprovisionar Hyperdrive. El despliegue no hace rollback automático si falla una comprobación posterior. Para recuperar, preparar una reversión en una rama feat, pasar por PR y promoverla; verificar compatibilidad con datos y migraciones existentes. Nunca restaurar credenciales administrativas en Actions.
