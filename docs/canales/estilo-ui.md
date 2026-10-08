# Estilo de la interfaz

## Fuentes que consultar

| Fuente | Qué consultar |
|---|---|
| [Mockup web y Design System](https://mockup-phi-wheat.vercel.app/) | Diseño aprobado, navegación, jerarquía, tipografía, componentes y estados del recorrido solicitado |
| [Mockup móvil](https://mobile-seven-snowy.vercel.app/#f1) | Pantallas y navegación del canal móvil; contrastar con el recorrido y criterios vigentes |
| [Marca y assets compartidos](../compartidos/assets/README.md) | Logos, variantes y consumo en cada canal |
| [Fuente de marca](../../packages/assets/brand/source.json) y [generador](../../packages/assets/scripts/generate.mjs) | Geometría, colores y generación; los registros de `src` son generados |
| [Estilos web](../../apps/web/src/index.css) | Estilos CSS base y estados de interacción implementados |
| [Tema móvil](../../apps/mobile/src/theme/index.ts) | Tokens implementados de color y espaciado; reutilizarlos al extender el canal |
| [Guía web](web/README.md) y [guía móvil](mobile/README.md) | Estructura y ejecución de cada canal |
| [Autenticación](../modulos/identity-consent-ecosystem/autenticacion.md#configuración-y-ejecución) | Branding de la pantalla alojada en WorkOS |

La implementación actual cubre una parte del diseño. Consultar el mockup del canal y recorrido antes de ampliar una pantalla; si falta la referencia móvil, indicarlo y solicitarla cuando afecte la decisión. No deducir todas las capacidades móviles de la web. Los criterios de aceptación gobiernan las reglas de negocio.

## Aplicación del estilo

- Conservar la identidad verde, proporciones de marca y componentes existentes. Tomar los valores de las fuentes y tokens; una captura alterada por una extensión del navegador no define la paleta.
- Reutilizar tokens y recursos compartidos. No copiar logos ni introducir colores, tipografías o componentes alternativos sin una necesidad del recorrido.
- Mantener texto mínimo y funcional: acciones, estados, errores y decisiones. Evitar eslóganes, descripciones decorativas y detalles internos de infraestructura.
- Cubrir carga, vacío, error, acceso denegado y degradación cuando apliquen. Mantener consistencia al reintentar, navegar atrás y cambiar de sesión; evitar envíos duplicados.
- Revisar foco, teclado, etiquetas accesibles, contraste, tamaños de pantalla y zoom en web. En móvil comprobar navegación y comportamiento nativo en dispositivo o emulador.
- La oferta preliminar no habilita contratación. Cuando se implemente operación offline, mostrar última sincronización y limitaciones; el dispositivo no es fuente contractual. Biometría exige autenticación principal, sesión válida y dispositivo registrado, con el mecanismo seguro del sistema operativo.

La presentación monocromática de los documentos técnicos es independiente de la identidad verde de la interfaz.
