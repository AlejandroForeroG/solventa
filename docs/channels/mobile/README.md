# Solventa mobile

Code: `apps/mobile`. Paths in this guide are relative to that application.

Expo/React Native application for Solventa's mobile channel.

## Structure

- `src/app`: routes and navigation composition with Expo Router.
- `src/features`: features organized by business capability.
- `src/theme`: shared application visual tokens.
- `@solventa/assets`: brand and colors shared with other channels.

Keep routes thin. Each capability's UI and logic live in its `src/features` directory; reusable code between capabilities may go in `src/shared` when a concrete need exists.

## Development

Run from the monorepo root:

```sh
npm install
npm run dev:mobile
```

Mobile workspace checks:

```sh
npm run lint --workspace @solventa/mobile
npm run types --workspace @solventa/mobile
npm run build --workspace @solventa/mobile
```

The current build exports for web. For native capability changes, validate the flow on a device/emulator; see [testing](../../testing.md).
