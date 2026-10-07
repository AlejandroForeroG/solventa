# Cómo trabajar en Solventa

## Antes de implementar

- Leer la tarea, sus criterios de aceptación y las fuentes de arquitectura y mockups pertinentes completas. Usar el contexto proporcionado fuera del repositorio; no copiar aquí planificación ni entregas académicas.
- Revisar el código existente y los README del componente. Si falta una fuente o hay una contradicción que afecta el comportamiento, explicarla antes de asumir una decisión.
- Implementar únicamente el alcance solicitado. La infraestructura disponible no significa que las funcionalidades ya existan.

## Arquitectura

- Fuente de arquitectura: [documento vigente de Solventa](https://docs.google.com/document/d/19xO1-UH7n3q_vsnDWfzJcDXH49-eQEDGCeWIDw4gQFU/edit). Leerlo completo antes de modificar límites, responsabilidades o integraciones. En el workspace local, la copia PDF está en `../output/semana8-arquitectura.pdf` y los ajustes de apoyo en `../docs/semana-7/04-ajustes-arquitectura.md`; estas rutas pertenecen al repositorio padre y no están incluidas en un clon del producto. Si no se puede acceder a la fuente, indicarlo; no sustituirla por supuestos. Mantener los documentos fuente fuera del producto.
- Mantener el monorepo: `apps/web` (React/Vite), `apps/mobile` (Expo/React Native) y tres backends Hono/Cloudflare Workers.
- Respetar sus responsabilidades: `acquisition-risk` para cotización y riesgo; `identity-consent-ecosystem` para identidad, autorización, consentimiento y socios; `policy-claims-payments` para pólizas, siniestros y pagos.
- Aplicar hexagonal con criterio: Domain contiene reglas; Application orquesta casos de uso mediante puertos; los adaptadores implementan HTTP, SQL, proveedores y mensajería. Domain y Application no importan SDK de infraestructura ni tipos de plataforma. No crear abstracciones sin una necesidad concreta.
- Cada backend conserva sus entidades, repositorios, esquema SQL, roles y transacciones. No consultar tablas ajenas; interactuar mediante contratos o eventos. `packages/contracts` comparte contratos de frontera, no entidades ni repositorios de dominio.
- Mantener como máximo una dependencia interna remota en el recorrido crítico. Esperar las llamadas por Service Binding y conservar deadlines y errores explícitos.
- Al implementar efectos asíncronos, asumir entrega al menos una vez: idempotencia, outbox/inbox, reintentos acotados y fallos observables. No prometer una transacción distribuida entre Workers o entre SQL y R2.
- Autenticación y permisos se verifican en servidor. WorkOS AuthKit está detrás del adaptador de Identidad; consultar `backend/identity-consent-ecosystem/README.md` para el contrato y sus límites. Una sesión válida no reemplaza permisos de negocio ni consentimiento vigente antes de consultar o reutilizar señales externas.

## Consultar la base de datos

- Ejecutar desde la raíz del producto. Consultar `infra/README.md` para operación y `infra/data-model.md` para tablas y permisos.
- Elegir explícitamente `local`, `dev`, `staging` o `prod`; sus bases son `solventa_<ambiente>`. Local usa SQL en `127.0.0.1:26258`; los remotos usan el origen configurado para ese ambiente.
- La configuración está en `.env.infra.<ambiente>` y las contraseñas runtime en `infra/.local/runtime.<ambiente>.json`, ambos ignorados por Git. La URL del archivo env es administrativa: para inspeccionar datos, reemplazar usuario y contraseña por el rol `solventa_<ambiente>_<esquema>`. No imprimir archivos, URL ni credenciales.
- Los esquemas son `identity`, `acquisition` y `policy`. Abrir una conexión separada con el rol correspondiente para cada propietario; no ampliar permisos para hacer consultas cruzadas.
- `backend/<backend>/runtime-grants.json` describe los permisos de tablas de negocio. Listar una tabla en el catálogo no concede acceso: `schema_migration_failures` es administrativa y runtime no puede leerla; el ledger `schema_migrations` sí permite SELECT.
- Usar `settings` y `clientFor` de `infra/database.mjs`, TLS verificado y una transacción de solo lectura. Empezar por listar tablas; un ambiente puede tener migraciones distintas. Consultar solo los campos necesarios, con filtros y límites, evitando PII en salidas.
- `npm run infra:<ambiente>:schema-verify` comprueba sin escribir versiones, checksums, tablas y lecturas propias. Para verificar public y marcas administrativas, el operador usa `node infra/schema-verify.mjs <ambiente> --admin`; no ejecutar ese modo con credenciales administrativas en CI/CD.
- Si falta configuración o estado de credenciales, restaurarlo desde la custodia del operador; no inventar contraseñas ni rotar usuarios. Para arrancar local, `npm run infra:up` inicia Docker y aplica migraciones pendientes: no es un comando de inspección.
- Inspeccionar datos no autoriza migrar, aprovisionar, desplegar, insertar, actualizar ni borrar, especialmente en staging/prod. Esas operaciones requieren su tarea y el flujo de promoción correspondiente.

Ejemplo de inspección de tablas; cambiar los dos argumentos finales para elegir ambiente y propietario:

```sh
node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { settings, clientFor, owners } from "./infra/database.mjs";
const [environment, schema] = process.argv.slice(1);
if (!owners.some(owner => owner.schema === schema)) throw Error("Invalid owner");
const config = await settings(environment);
const state = JSON.parse(await readFile(`infra/.local/runtime.${environment}.json`, "utf8"));
const url = new URL(config.url);
url.pathname = "/" + config.database;
url.username = `solventa_${environment}_${schema}`;
url.password = state.passwords[schema];
const db = clientFor(url, { ca: config.ssl.ca, rejectUnauthorized: true });
try {
  await db.connect();
  await db.query("BEGIN TRANSACTION READ ONLY");
  const result = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name", [schema]);
  console.log(JSON.stringify(result.rows));
} finally { await db.end(); }
' local identity
```

## Mockups e interfaz

- Usar `packages/assets` para la marca y recursos compartidos. Consumir sus registros `@solventa/assets/web` y `@solventa/assets/mobile`; no duplicar logos entre canales. Mantener la identidad verde y consultar su README antes de añadir variantes.

- Consultar el mockup vigente del canal y recorrido solicitado. Respetar navegación, jerarquía, componentes y estados; no duplicar automáticamente las funciones web en móvil.
- Los mockups orientan la interfaz; los criterios de aceptación y las reglas de negocio gobiernan el comportamiento. No convertir una simulación visual en una garantía de seguridad o negocio.
- Implementar los estados pertinentes de carga, vacío, error, acceso denegado y degradación. Una oferta preliminar no habilita contratación; en móvil mostrar modo offline y última sincronización cuando corresponda.
- Mantener texto mínimo y funcional, etiquetas claras, navegación por teclado y foco en web, y controles y capacidades nativas en móvil. Respetar idioma y formatos previstos.
- La biometría requiere autenticación principal previa, sesión válida y dispositivo registrado; usar el mecanismo seguro del sistema operativo. Un botón simulado no acredita biometría real.

## Verificación y entrega

- Trabajar en ramas `feat/<descripcion>`; no usar el prefijo `codex`. La descripción resume el cambio, como `feat/agregar-login`. Los commits y títulos de PR usan `feat|fix|refactor|test(modulo): descripción`, máximo 72 caracteres en la primera línea.
- Integrar mediante PR: `feat/*` hacia `dev`, `dev` hacia `staging` y `staging` hacia `prod`. No hacer commits o pushes directos a las ramas de ambientes. CI valida el PR; al integrarlo, CD publica el ambiente correspondiente.
- Hacia dev, exigir todos los checks verdes sin aprobación humana. Hacia staging y prod, exigir además una aprobación antes de integrar el PR.
- Validar la versión desplegada en el ambiente anterior antes de aprobar su promoción. Promover con merge normal para conservar la historia; no usar squash ni rebase entre ramas de ambientes.

- Usar datos sintéticos. No guardar secretos ni PII en Git, respuestas de diagnóstico o logs. Mantener credenciales y recursos separados entre local, dev, staging y prod.
- Ejecutar las comprobaciones pertinentes al cambio; para código, usar `npm run check` y las pruebas del flujo afectado. Validar infraestructura con los comandos de `infra/README.md` cuando se modifique.
- Para interfaz, revisar el recorrido real frente al mockup y sus criterios. El build/export móvil no sustituye una prueba nativa de biometría, permisos o almacenamiento.
- Reportar qué cambió, qué se verificó y qué sigue pendiente. Usar solo evidencia real; no presentar scaffolding, mocks o despliegue de infraestructura como funcionalidades completas.
- Documentar comandos, contratos y decisiones técnicas implementadas. Mantener fuera de este repositorio planificación, referencias a Jira, informes académicos y conversaciones.
