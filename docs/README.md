# Documentación de Solventa

Esta carpeta contiene la documentación técnica vigente del producto. La organización sigue las responsabilidades de la vista funcional de la arquitectura. Los documentos describen el estado implementado y distinguen las capacidades pendientes.

## Módulos del sistema

| Módulo | Responsabilidad | Código |
|---|---|---|
| [Adquisición y Riesgo](modulos/acquisition-risk/README.md) | Cotización, pricing, perfilamiento, underwriting, ofertas y actualización autorizada de señales | `backend/acquisition-risk` |
| [Identidad, Consentimiento y Ecosistema](modulos/identity-consent-ecosystem/README.md) | Identidad, autorización, consentimiento, dispositivos y socios | `backend/identity-consent-ecosystem` |
| [Pólizas, Siniestros y Pagos](modulos/policy-claims-payments/README.md) | Emisión, pólizas, cobro, conciliación, siniestros, evidencia e indemnización | `backend/policy-claims-payments` |

## Canales y componentes compartidos

| Guía | Código |
|---|---|
| [Web](canales/web/README.md) | `apps/web` |
| [Móvil](canales/mobile/README.md) | `apps/mobile` |
| [Contratos y versionado de API](compartidos/contracts/README.md) | `packages/contracts` |
| [Marca y recursos compartidos](compartidos/assets/README.md) | `packages/assets` |

## Guías transversales

- [Estilo UI y sus fuentes](canales/estilo-ui.md).
- [Instalación y desarrollo](desarrollo.md).
- [Arquitectura y fronteras](arquitectura.md).
- [Estándar de endpoints y decisiones de negocio](estandares-endpoints.md).
- [Pruebas con propósito](pruebas.md).
- [Revisión de cambios y criterios de aceptación](revision-cambios.md).
- [Operación de infraestructura](infraestructura/README.md).
- [Consultas SQL de solo lectura](infraestructura/consultas-sql.md).
- [Modelo SQL y permisos](infraestructura/modelo-datos.md).
- [Crear, aplicar y recuperar migraciones](infraestructura/migraciones.md).
- [CI/CD y promoción de ambientes](infraestructura/ci-cd.md).

## Mantener la documentación

Las reglas obligatorias están en [AGENTS.md](../AGENTS.md#required-documentation). Buscar primero el módulo y el tema existentes; actualizar esa guía en la misma rama y PR que cambia el comportamiento. Crear un documento solo si el tema aún no tiene uno, dentro de su módulo, y enlazarlo desde su índice.

Una explicación tiene un único documento de referencia. Los README junto al código sirven de enlaces hacia estas guías. Los cambios compartidos se documentan una vez en su guía transversal y se enlazan desde los módulos afectados. El historial queda en Git: mantener el texto vigente, retirar instrucciones obsoletas y no crear copias por rama, feature, sprint o ambiente. Cada PR enlaza las guías que crea o modifica desde su rama de origen.
