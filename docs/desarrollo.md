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

`check` comprueba política Git/promociones, dependencias del núcleo, pruebas de arquitectura, credenciales y fronteras entre ambientes, versionado y contratos de la API (pruebas y linter OpenAPI), lint, tipos y builds. El workspace móvil exporta para web; no valida capacidades nativas. Los doce Workers remotos se empaquetan con `--dry-run` para dev, staging y prod. CI también levanta CockroachDB con TLS y ejecuta SQL y RPC reales mediante Workers locales.

`npm ci` instala hooks nativos de Git mediante `prepare`. `pre-commit` y `pre-push` validan la rama; `commit-msg` valida el mensaje. Usar ramas `feat/<descripcion>`, `fix/<descripcion>`, `refactor/<descripcion>` o `test/<descripcion>` en minúsculas, con guiones, y títulos `feat|fix|refactor|test(modulo): descripción` de hasta 150 caracteres. Ejemplos: `feat/agregar-login` y `feat(auth): agregar login`. El cuerpo del commit admite más detalle.

Crear la rama base desde `staging`, y desde ella su pareja con sufijo `-dev` para PR a dev. La base lista se promueve por PR a staging; cada release va de staging a prod. Correcciones de `-dev` vuelven a la base por cherry-pick y se sincronizan/prueban otra vez. Seguir el [Gitflow y CI/CD](infraestructura/ci-cd.md), incluidas las reglas de merge y despliegue previo.

## Desarrollo local

Los SVG de marca y sus variantes están en [packages/assets](compartidos/assets/README.md). Importar `brandAssets` desde `@solventa/assets/web` o `@solventa/assets/mobile`; el catálogo de rutas está en `@solventa/assets`. Ambos canales consumen la misma fuente.

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

## Documentación de referencia

Consultar [módulos y estado implementado](README.md), [fronteras de arquitectura](arquitectura.md) y [operación de infraestructura](infraestructura/README.md) antes de extender un recorrido.
