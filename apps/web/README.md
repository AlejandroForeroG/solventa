# Web

React, Vite y TypeScript. Desde la raíz: `npm run dev:web`. Contiene la entrada,
comprobación de sesión y cierre de sesión; los recorridos de negocio están pendientes.

Las credenciales se introducen en WorkOS AuthKit. La web accede a Identidad por
Service Binding y no recibe tokens. Consultar [autenticación](../../backend/identity-consent-ecosystem/README.md)
para iniciar el recorrido local completo en `http://localhost:8787`.

Logo y favicon proceden de `packages/assets`; conservar la identidad verde y los
estados de carga, error y sesión al extender la interfaz.
