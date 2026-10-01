# Cómo trabajar en Solventa

## Antes de implementar

- Leer la tarea, sus criterios de aceptación y las fuentes de arquitectura y mockups pertinentes completas. Usar el contexto proporcionado fuera del repositorio; no copiar aquí planificación ni entregas académicas.
- Revisar el código existente y los README del componente. Si falta una fuente o hay una contradicción que afecta el comportamiento, explicarla antes de asumir una decisión.
- Implementar únicamente el alcance solicitado. La infraestructura disponible no significa que las funcionalidades ya existan.

## Arquitectura

- Mantener el monorepo: `apps/web` (React/Vite), `apps/mobile` (Expo/React Native) y tres backends Hono/Cloudflare Workers.
- Respetar sus responsabilidades: `acquisition-risk` para cotización y riesgo; `identity-consent-ecosystem` para identidad, autorización, consentimiento y socios; `policy-claims-payments` para pólizas, siniestros y pagos.
- Aplicar hexagonal con criterio: Domain contiene reglas; Application orquesta casos de uso mediante puertos; los adaptadores implementan HTTP, SQL, proveedores y mensajería. Domain y Application no importan SDK de infraestructura ni tipos de plataforma. No crear abstracciones sin una necesidad concreta.
- Cada backend conserva sus entidades, repositorios, esquema SQL, roles y transacciones. No consultar tablas ajenas; interactuar mediante contratos o eventos. `packages/contracts` comparte contratos de frontera, no entidades ni repositorios de dominio.
- Mantener como máximo una dependencia interna remota en el recorrido crítico. Esperar las llamadas por Service Binding y conservar deadlines y errores explícitos.
- Al implementar efectos asíncronos, asumir entrega al menos una vez: idempotencia, outbox/inbox, reintentos acotados y fallos observables. No prometer una transacción distribuida entre Workers o entre SQL y R2.
- Autenticación y permisos se verifican en servidor. La integración OAuth/OIDC queda detrás de un adaptador; no dar por elegido un proveedor. Una sesión válida no reemplaza el consentimiento vigente antes de consultar o reutilizar señales externas.

## Mockups e interfaz

- Consultar el mockup vigente del canal y recorrido solicitado. Respetar navegación, jerarquía, componentes y estados; no duplicar automáticamente las funciones web en móvil.
- Los mockups orientan la interfaz; los criterios de aceptación y las reglas de negocio gobiernan el comportamiento. No convertir una simulación visual en una garantía de seguridad o negocio.
- Implementar los estados pertinentes de carga, vacío, error, acceso denegado y degradación. Una oferta preliminar no habilita contratación; en móvil mostrar modo offline y última sincronización cuando corresponda.
- Mantener texto mínimo y funcional, etiquetas claras, navegación por teclado y foco en web, y controles y capacidades nativas en móvil. Respetar idioma y formatos previstos.
- La biometría requiere autenticación principal previa, sesión válida y dispositivo registrado; usar el mecanismo seguro del sistema operativo. Un botón simulado no acredita biometría real.

## Verificación y entrega

- Trabajar en ramas `feat/<caso-o-ticket>`; no usar el prefijo `codex`. Los commits y títulos de PR usan `feat|fix|refactor|test(modulo): mensaje`, máximo 72 caracteres en la primera línea.
- Integrar mediante PR: `feat/*` hacia `dev`, `dev` hacia `staging` y `staging` hacia `prod`. No hacer commits o pushes directos a las ramas de ambientes. CI valida el PR; al integrarlo, CD publica el ambiente correspondiente.
- Hacia dev, exigir todos los checks verdes sin aprobación humana. Hacia staging y prod, exigir además una aprobación antes de integrar el PR.
- Validar la versión desplegada en el ambiente anterior antes de aprobar su promoción. Promover con merge normal para conservar la historia; no usar squash ni rebase entre ramas de ambientes.

- Usar datos sintéticos. No guardar secretos ni PII en Git, respuestas de diagnóstico o logs. Mantener credenciales y recursos separados entre local, dev, staging y prod.
- Ejecutar las comprobaciones pertinentes al cambio; para código, usar `npm run check` y las pruebas del flujo afectado. Validar infraestructura con los comandos de `infra/README.md` cuando se modifique.
- Para interfaz, revisar el recorrido real frente al mockup y sus criterios. El build/export móvil no sustituye una prueba nativa de biometría, permisos o almacenamiento.
- Reportar qué cambió, qué se verificó y qué sigue pendiente. Usar solo evidencia real; no presentar scaffolding, mocks o despliegue de infraestructura como funcionalidades completas.
- Documentar comandos, contratos y decisiones técnicas implementadas. Mantener fuera de este repositorio planificación, referencias a Jira, informes académicos y conversaciones.
