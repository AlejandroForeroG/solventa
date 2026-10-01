# CI y despliegues

`CI` ejecuta en los PR: instalación reproducible, arquitectura, pruebas de credenciales y ambientes, lint, tipos, exportación móvil y empaquetado de Workers para dev, staging y prod. Luego levanta CockroachDB con TLS, valida aislamiento y prueba SQL/RPC desde Workers locales. Detiene los contenedores al terminar. Los PR no reciben secretos remotos.

`Deploy` se ejecuta al publicar en main para desplegar dev. También admite una ejecución manual desde Actions con el ambiente y un SHA completo opcional. Primero ejecuta la misma CI sobre ese commit. Solo si pasa, instala, restaura las credenciales del ambiente, publica sus cuatro Workers y valida SQL, RPC, aislamiento entre bases y protección del diagnóstico. Serializa los despliegues por ambiente sin cancelar una publicación en curso.

Los tres ambientes requieren un commit integrado en main y un workflow ejecutado desde main. Sus ambientes de GitHub aceptan únicamente esa rama. Los tokens de Workers Scripts permiten modificar scripts de la cuenta y no aíslan dev de prod por nombre, por lo que dev aplica la misma frontera de código integrado. Para promover una versión, ejecutar `Deploy` en staging con el SHA validado en dev, comprobar los flujos del candidato y después repetir en prod con el mismo SHA. La promoción es explícita. Este flujo básico no implementa aprobación por un segundo revisor ni comprueba automáticamente que el SHA haya pasado anteriormente por staging.

## Configuración de GitHub

En el repositorio, ir a **Settings > Environments**. Crear `dev`, `staging` y `prod`. En cada uno configurar:

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

En los tres ambientes, seleccionar **Deployment branches and tags > Selected branches and tags**, y agregar la rama `main`. Las restricciones de ambiente aplican a la rama que ejecuta el workflow. El script también comprueba que el commit elegido forme parte de main. Los entornos privados requieren un plan de GitHub compatible. Los revisores obligatorios pueden requerir un plan distinto y no se presuponen.

Los tres ambientes deben estar aprovisionados antes de usar CD. El operador ejecuta `infra:<ambiente>:up` al incorporar migraciones y actualiza el estado custodiado si realiza una recuperación coordinada. CD falla si falta un secret, si los IDs o bindings cruzan ambientes, si cambia el origen TLS esperado o si una sonda falla. Los archivos temporales se eliminan en un paso `always()` y nunca se suben como artifacts.

## Ejecución

Tras integrar el workflow en main, abrir **Actions > Deploy > Run workflow**. Seleccionar main, staging o prod como ambiente y el SHA completo de la versión. Para dev, el push a main dispara el flujo automáticamente. La pestaña Actions conserva el commit, resultado de pruebas y resultado del despliegue.

Cambiar solo código no requiere reprovisionar Hyperdrive. Migraciones y cambios de recursos deben aplicarse antes del despliegue por ambiente. Un rollback de Workers conserva datos y migraciones SQL; se debe evaluar la compatibilidad del código anterior.

Referencias: [GitHub Actions y Cloudflare](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [ambientes de GitHub](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), [permisos de tokens](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
