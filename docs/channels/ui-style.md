# Interface style

## Sources to consult

| Source | Check |
|---|---|
| [Web mockup and Design System](https://mockup-phi-wheat.vercel.app/) | Approved design, navigation, hierarchy, typography, components and states for the requested flow |
| [Mobile mockup](https://mobile-seven-snowy.vercel.app/#f1) | Mobile screens and navigation; compare with the current flow and criteria |
| [Brand and shared assets](../shared/assets/README.md) | Logos, variants and channel usage |
| [Brand source](../../packages/assets/brand/source.json) and [generator](../../packages/assets/scripts/generate.mjs) | Geometry, colors and generation; `src` registries are generated |
| [Web styles](../../apps/web/src/index.css) | Implemented base CSS and interaction states |
| [Mobile theme](../../apps/mobile/src/theme/index.ts) | Implemented color/spacing tokens; reuse them when extending the channel |
| [Web](web/README.md) and [mobile](mobile/README.md) guides | Structure and execution for each channel |
| [Authentication](../modules/identity-consent-ecosystem/authentication.md#configuration-and-running) | WorkOS hosted-screen branding |

The current implementation covers part of the design. Consult the channel/flow mockup before extending a screen; disclose a missing mobile reference and request it when it affects a decision. Do not infer all mobile capabilities from web. Acceptance criteria govern business rules.

## Applying the style

- Preserve the green identity, brand proportions and existing components. Use source/token values; a screenshot modified by a browser extension does not define the palette.
- Reuse tokens and shared assets. Do not copy logos or introduce alternative colors, fonts or components without a flow-specific need.
- Keep copy minimal and functional: actions, states, errors and decisions. Avoid slogans, decorative descriptions and internal infrastructure details. UI copy follows the approved channel language; code identifiers and documentation use English.
- Cover loading, empty, error, access-denied and degraded states where applicable. Keep retries, back navigation and session changes consistent; prevent duplicate submissions.
- Check focus, keyboard, accessible labels, contrast, screen sizes and zoom on web. On mobile, check navigation and native behavior on a device or emulator.
- A preliminary offer cannot enable contracting. When implementing offline behavior, show last synchronization and limitations; the device is not the contractual source. Biometrics require primary authentication, a valid session and a registered device, using the operating system's secure mechanism.

Monochrome technical documentation is independent of the UI's green identity.
