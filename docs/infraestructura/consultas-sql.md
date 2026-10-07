# Consultas SQL de solo lectura

- Ejecutar desde la raíz del producto. Consultar [operación](README.md) y [modelo SQL](modelo-datos.md) para tablas y permisos.
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
