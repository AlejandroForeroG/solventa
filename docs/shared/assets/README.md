# Shared assets

Code: `packages/assets`. Resource/generator paths are relative to that package; run commands from the repository root.

`@solventa/assets` centralizes visual assets for web/mobile. The brand uses green `#0B6B5F`, white and dark green `#062F2A`.

| Variant | Use |
|---|---|
| `logo` | Symbol and word in a horizontal layout |
| `icon` | Symbol only, in a square frame |
| `wordmark` | The word “solventa” only |
| `stacked` | Symbol above the word |

Each variant has `green`, `white` and `dark`. Use white on dark backgrounds; green/dark on light backgrounds. Preserve proportions and clear space.

## Imports

Web: the registry resolves URLs through Vite.

```tsx
import { brandAssets } from '@solventa/assets/web';

<img src={brandAssets.logo.green} alt="Solventa" width={240} />
```

Mobile: the registry uses literal `require` paths so Metro includes PNGs and selects `@2x`/`@3x` resolutions.

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

`src/index.ts` centralizes `assetPaths` and `brandColors`. Its paths are relative to the package; use channel registries to render. Direct file imports are also available, for example `@solventa/assets/brand/solventa-icon-green.svg`.

All twelve SVGs are complete vectors: symbol and letters converted to paths, with no embedded images, external fonts or remote links. Transparent PNGs are generated from these same vectors for React Native's `Image`; this usage needs no additional SVG renderer.

## Editing or adding assets

Source geometry lives in `brand/source.json`. To change the brand, edit that source or colors/compositions in `scripts/generate.mjs`, then run from the root:

```sh
npm run generate --workspace @solventa/assets
```

The command regenerates SVGs, PNGs in three resolutions and registries. Commit sources and generated files together. Do not duplicate them in `apps/web` or `apps/mobile`. Future shared assets belong here; channel-exclusive assets may stay in their application.

Packaging references: [Expo assets](https://docs.expo.dev/develop/user-interface/assets/) and [React Native static images](https://reactnative.dev/docs/images).
