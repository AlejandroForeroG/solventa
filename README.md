# Solventa

Monorepo TypeScript con aplicaciones web y móvil y tres backends independientes.

| Ruta | Componente |
|---|---|
| apps/web | React y Vite; Worker de activos, autenticación por binding y diagnóstico |
| apps/mobile | React Native y Expo |
| backend/acquisition-risk | Adquisición y Riesgo |
| backend/policy-claims-payments | Pólizas, Siniestros y Pagos |
| backend/identity-consent-ecosystem | Identidad, Consentimiento y Ecosistema |
| packages/contracts | Contratos de frontera |
| packages/assets | Marca y assets compartidos de web y móvil |
| infra | Configuración operativa |

## Instalación y comprobación

Usar Node.js 22.21.1 y npm 10.9.4. Ejecutar desde esta raíz:

```sh
npm ci
npm run check
```

`check` comprueba las dependencias del núcleo, las pruebas de arquitectura, credenciales y fronteras entre ambientes, el versionado y los contratos de la API (pruebas y linter OpenAPI), lint, tipos y builds. El móvil exporta un bundle Android. Los doce Workers remotos se empaquetan con `--dry-run` para dev, staging y prod. CI también levanta CockroachDB con TLS y ejecuta SQL y RPC reales mediante Workers locales.

`npm ci` instala hooks nativos de Git mediante `prepare`. `pre-commit` y `pre-push` validan la rama; `commit-msg` valida el mensaje. Usar ramas `feat/<descripcion>`, `fix/<descripcion>`, `refactor/<descripcion>` o `test/<descripcion>` en minúsculas, con guiones, y títulos `feat|fix|refactor|test(modulo): descripción` de hasta 150 caracteres. Ejemplos: `feat/agregar-login` y `feat(auth): agregar login`. El cuerpo del commit admite más detalle.

Crear la rama de trabajo desde `dev`. Abrir PR hacia `dev`; después promover con PR de `dev` a `staging` y de `staging` a `prod`. Cada integración dispara CI y el despliegue correspondiente. Ver [CI/CD](infra/ci-cd.md).

## Desarrollo local

Los SVG de marca y sus variantes están en [packages/assets](packages/assets/README.md). Importar `brandAssets` desde `@solventa/assets/web` o `@solventa/assets/mobile`; el catálogo de rutas está en `@solventa/assets`. Ambos canales consumen la misma fuente.

Requiere Docker con Compose:

```sh
npm run infra:up
npm run build --workspace @solventa/web
npm run dev:backend
```

`dev:backend` inicia el Worker web y los tres servicios con sus bindings locales. Abrir la dirección que imprime Wrangler. En otras terminales pueden iniciarse los canales:

```sh
npm run dev:web
npm run dev:mobile
```

Vite usa 5173 para editar la interfaz. CockroachDB escucha únicamente en loopback: SQL 26258 y consola HTTPS 8088. `/health` indica que el proceso responde; el diagnóstico protegido `/internal/infra` consulta los tres almacenes y usa RPC entre servicios. `npm run test:infra` lo comprueba en 8790. `npm run infra:down` detiene el entorno y conserva datos. El móvil requiere un dispositivo o emulador para validar capacidades nativas.

## Límites técnicos

Cada backend reserva `domain`, `application`, `application/ports` y `adapters`. Los SDK pertenecen a adaptadores o a la raíz de composición. Cada propietario mantiene sus migraciones y acceso a datos; otros dominios consumen contratos.

La base implementa infraestructura local y tres ambientes remotos: `dev`, `staging` y `prod`. Cada ambiente tiene web, tres Workers privados, tres conexiones Hyperdrive y su base CockroachDB con esquemas y credenciales separados. Ver [operación](infra/README.md) y [fronteras](backend/README.md).

La autenticación web usa WorkOS AuthKit con PKCE, sesión sellada y usuario interno
verificado en SQL. El alta de cliente nuevo confirma sesión, auditoría y evento de
creación juntos; logout confirma revocación local y auditoría. Ver
[autenticación](backend/identity-consent-ecosystem/README.md) y sus límites.

Cotización, biometría, consentimiento efectivo, autorización de negocio y pagos
siguen pendientes. `/api/*` devuelve 404; el secreto de diagnóstico no sustituye
la sesión de usuario. `packages/contracts` define el versionado de la API (`/api/v1`),
su spec OpenAPI base y el esquema de captura histórica; aún no contiene contratos de
endpoints de negocio. Promover autenticación requiere migraciones y credenciales propias;
producción necesita WorkOS habilitado antes de publicar este código. El clúster
SQL compartido sigue siendo un fallo común y requiere evaluación antes de datos
reales. No hay alta disponibilidad local ni validación de rendimiento o ejecución
móvil nativa.
