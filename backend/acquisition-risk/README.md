# Acquisición

Worker independiente con esquema, rol runtime y binding Hyperdrive propios. `/health` indica liveness. La raíz de composición expone un diagnóstico RPC protegido por el Worker web y comprueba SQL y Identidad mediante RPC.

El dominio y la aplicación permanecen vacíos. Las migraciones posteriores crean las tablas propias de negocio y auditoría/outbox/inbox. Ver [modelo SQL](../../infra/data-model.md), [fronteras](../README.md) y [operación](../../infra/README.md). Ejecutar `npm run infra:up` desde la raíz antes del desarrollo local.
