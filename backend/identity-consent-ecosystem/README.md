# Identidad

Worker independiente con esquema, rol runtime y binding Hyperdrive propios. `/health` indica liveness. La raíz de composición expone un diagnóstico RPC protegido por el Worker web y comprueba SQL y su almacén.

El dominio y la aplicación permanecen vacíos. La migración inicial registra la línea base, sin tablas de negocio. Ver [fronteras](../README.md) y [operación](../../infra/README.md). Ejecutar `npm run infra:up` desde la raíz antes del desarrollo local.
