# Assets compartidos

Código: `packages/assets`. Las rutas de recursos y generadores son relativas a ese paquete; ejecutar los comandos desde la raíz del repositorio.

`@solventa/assets` concentra recursos visuales de web y móvil. La marca usa verde `#0B6B5F`, blanco y verde oscuro `#062F2A`.

| Variante | Uso |
|---|---|
| `logo` | Símbolo y palabra, en horizontal |
| `icon` | Símbolo solo, con encuadre cuadrado |
| `wordmark` | Palabra «solventa» sola |
| `stacked` | Símbolo arriba de la palabra |

Cada variante tiene `green`, `white` y `dark`. Usar blanco sobre un fondo oscuro; verde u oscuro sobre fondos claros. Conservar proporciones y espacio libre.

## Importaciones

Web: el registro resuelve las URL mediante Vite.

```tsx
import { brandAssets } from '@solventa/assets/web';

<img src={brandAssets.logo.green} alt="Solventa" width={240} />
```

Móvil: el registro usa `require` con rutas literales para que Metro incluya los PNG y seleccione las resoluciones `@2x`/`@3x`.

```tsx
import { Image } from 'react-native';
import { assetPaths } from '@solventa/assets';
import { brandAssets } from '@solventa/assets/mobile';

<Image
  source={brandAssets.logo.green}
  accessibilityLabel="Solventa"
  accessible
  resizeMode="contain"
  style={{ width: 240, aspectRatio: assetPaths.logo.green.aspectRatio }}
/>
```

`src/index.ts` centraliza `assetPaths` y `brandColors`. Sus rutas son relativas al paquete; para renderizar usar los registros del canal. También se pueden importar archivos directamente, por ejemplo `@solventa/assets/brand/solventa-icon-green.svg`.

Los doce SVG son vectores completos: símbolo y letras convertidos a trazados, sin imágenes incrustadas, fuentes externas ni enlaces remotos. Los PNG transparentes se generan desde esos mismos vectores para el componente `Image` de React Native. No se requiere un renderizador SVG adicional para ese uso.

## Editar o añadir recursos

La geometría fuente vive en `brand/source.json`. Para cambiar la marca, editar esa fuente o los colores/composiciones de `scripts/generate.mjs` y ejecutar desde la raíz:

```sh
npm run generate --workspace @solventa/assets
```

El comando regenera los SVG, los PNG de tres resoluciones y los registros. Subir juntos la fuente y los archivos generados. No duplicarlos en `apps/web` ni `apps/mobile`. Los futuros assets compartidos pertenecen a este paquete; los exclusivos de un canal pueden permanecer en su aplicación.

Referencia de empaquetado: [assets en Expo](https://docs.expo.dev/develop/user-interface/assets/) y [imágenes estáticas de React Native](https://reactnative.dev/docs/images).
