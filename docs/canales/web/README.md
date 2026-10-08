# Web

Código: `apps/web`. Los comandos se ejecutan desde la raíz del repositorio.

React, Vite y TypeScript. Desde la raíz del repositorio: `npm run dev:web`. Contiene la entrada,
comprobación de sesión y cierre de sesión; los recorridos de negocio están pendientes.

Las credenciales se introducen en WorkOS AuthKit. La web accede a Identidad por
Service Binding y no recibe tokens. Consultar [autenticación](../../modulos/identity-consent-ecosystem/autenticacion.md)
para iniciar el recorrido local completo en `http://localhost:8787`.

El Worker aplica el versionado de la API a las rutas `/api/v<N>/...`: añade las cabeceras de deprecación y responde 410 cuando una versión llega a su fecha de retiro. Ver
[contratos](../../compartidos/contracts/README.md).

Logo y favicon proceden de `packages/assets`; conservar la identidad verde y los
estados de carga, error y sesión al extender la interfaz.
