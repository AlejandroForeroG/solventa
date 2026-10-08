# Pruebas que protegen la funcionalidad

Escribir pruebas unitarias para proteger reglas, contratos o comportamiento que pueda romperse al cambiar el código. Elegirlas por el riesgo real del caso de uso, no por cantidad o porcentaje. Un cambio documental o un movimiento reversible sin cambio de comportamiento no necesita unit tests artificiales.

## Diseñar la prueba

- Describir una entrada/estado y el resultado observable: valor, error, transición válida o efecto exigido. La prueba debe fallar si se rompe ese comportamiento, aunque las funciones mantengan sus nombres.
- Cubrir el caso válido y los límites relevantes: datos vacíos/invalidos, frontera numérica o temporal, autorización/consentimiento denegados, duplicados, conflicto de concurrencia y dependencia fallida cuando el flujo los tenga.
- Mantener datos sintéticos pequeños y deterministas. Inyectar reloj, repositorios o proveedores cuando se necesiten; no depender de la hora real, red, orden de otras pruebas ni sleeps para validar reglas.
- Usar puertos en memoria en Domain/Application y HTTP. No simular la función que se pretende validar; aislar solo sus dependencias. No exigir Docker a una prueba unitaria.
- Evitar asserts de variables privadas, llamadas triviales, snapshots enormes, mocks que repiten la implementación y pruebas escritas únicamente para subir cobertura. Verificar interacciones cuando sean parte de una garantía, como no llamar al proveedor con consentimiento inválido.

## Cuando cambia la funcionalidad

Actualizar las expectativas de los unit tests junto con el cambio intencional del comportamiento y su documentación. Añadir una regresión cuando se corrige un error; conservar las pruebas de las reglas que siguen vigentes. No borrar o relajar un test solo para poner CI verde: determinar si expone una regresión o un requisito que cambió, y explicar el cambio en el PR.

Por ejemplo, si cambia una regla de cálculo, probar entradas y resultados de la versión nueva, conservar la capacidad de interpretar decisiones históricas y validar que la ficha registra la versión realmente aplicada. Si cambia una ruta, actualizar sus respuestas y errores de contrato y mantener las garantías de autorización y versionado.

## Elegir la capa

| Capa | Comprobar | Dependencias |
|---|---|---|
| Dominio | Regla, invariantes y fronteras | Valores propios, sin plataforma |
| Application | Orquestación, errores, consentimiento, idempotencia y captura de decisión | Puertos en memoria |
| HTTP/contrato | Entrada, status, respuesta y compatibilidad OpenAPI/Pact cuando se implemente | `createHttp(deps)` sin SQL real |
| Adaptador SQL | Constraints, persistencia/transacción, catálogo y permisos | Base local/temporal real |
| Integración | Bindings, coordinación y errores entre servicios | Workers y SQL locales |
| E2E/nativa | Recorrido del usuario y capacidades del dispositivo | Navegador/dispositivo real |

Una prueba con un repositorio en memoria no acredita una transacción SQL. Un build/export móvil no acredita biometría o almacenamiento seguro. Un smoke remoto no acredita todo el recorrido de negocio.

## Ejecución y mantenimiento

Usar el runner existente: `node --test` para herramientas `.mjs` y `tsx --test` para suites TypeScript. Integrar las nuevas suites relevantes en los scripts del módulo/raíz y en `npm run check`; no dejar pruebas sin ejecución en CI. Consultar los scripts reales de [package.json](../package.json).

Ejecutar primero la suite afectada; después `npm run check` para un cambio de código. Las [migraciones](infraestructura/migraciones.md) y adaptadores SQL requieren sus pruebas reales adicionales. Una vez que pasan las comprobaciones pertinentes, no repetir o ampliar pruebas sin una nueva modificación, fallo o incertidumbre que lo justifique.

En el PR enlazar la documentación nueva/actualizada e indicar qué comportamiento protege cada conjunto relevante, los comandos ejecutados y sus resultados reales. No afirmar que existen contratos Pact o casos de uso aún pendientes.
