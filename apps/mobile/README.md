# Solventa móvil

Aplicación Expo/React Native del canal móvil de Solventa.

## Estructura

- `src/app`: rutas y composición de navegación con Expo Router.
- `src/features`: funcionalidades organizadas por capacidad de negocio.
- `src/theme`: tokens visuales compartidos por la aplicación.
- `@solventa/assets`: marca y colores compartidos con los demás canales.

Las rutas deben permanecer delgadas. La interfaz y la lógica de cada capacidad viven dentro de su carpeta en `src/features`; el código reutilizable entre capacidades puede añadirse a `src/shared` cuando exista una necesidad real.

## Desarrollo

Ejecutar desde la raíz del monorepo:

```bash
npm install
npm run dev:mobile
```

Comprobaciones del workspace móvil:

```bash
npm run lint --workspace @solventa/mobile
npm run types --workspace @solventa/mobile
npm run build --workspace @solventa/mobile
```
