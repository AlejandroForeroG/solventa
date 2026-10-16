# Web application fonts

This directory vendors the exact unmodified WOFF2 files returned by the application's original Google Fonts request. The Google-hosted stylesheet was captured with a modern Chromium user agent; only its `src` URLs are changed to relative local files in `fonts.css`. Font families, weights, normal style, `font-display: swap`, Unicode ranges and fallback choices remain unchanged.

| Family | Declared weights | Included subsets |
|---|---|---|
| IBM Plex Sans | 400, 500, 600 | Cyrillic extended, Cyrillic, Greek, Vietnamese, Latin extended, Latin |
| IBM Plex Mono | 400, 500, 600 | Cyrillic extended, Cyrillic, Vietnamese, Latin extended, Latin |
| Space Grotesk | 500, 600, 700 | Vietnamese, Latin extended, Latin |

There are 42 face declarations and 24 distinct WOFF2 files (363,264 bytes); some weights share a variable-font binary. All subsets from the original response are retained, covering the application's es-CO/en-US text without narrowing previously available glyph ranges. CSS requests for a weight outside this declared set keep their original browser matching behavior; no new synthetic or substituted weight is introduced.

`manifest.json` records the original stylesheet URL, capture user agent, immutable Google font URLs, binary SHA-256 digests and license provenance. Font CDN path versions are part of those source URLs. Fonts are redistributed without conversion, subsetting, renaming their internal families or changing their bytes. Source licenses are pinned to Google Fonts repository revision `94301472b4d809299b4775bc6502592b83dd6934`:

- [IBM Plex Sans license](ibmplexsans-OFL.txt).
- [IBM Plex Mono license](ibmplexmono-OFL.txt).
- [Space Grotesk license](spacegrotesk-OFL.txt).

All three are SIL Open Font License 1.1 with their original copyright notices. Vendored license text uses UTF-8, LF line endings and no trailing spaces/tabs; these whitespace-only normalizations preserve the complete legal wording and copyright. For each license, `sourceSha256` identifies the original downloaded bytes and `sha256` identifies the normalized vendored bytes, matching Git's LF checkout convention. Font binaries are unchanged. Complete normalized license notices are also retained in the stylesheet's preserved legal comment so the production CSS distributes the notices together with the font assets.

The web entry imports `@solventa/assets/fonts/web.css`. Vite emits the referenced WOFF2 files as same-origin assets and rewrites their URLs. The existing full IBM Plex assets under `../ibm-plex` remain the API viewer's independent pinned font source; replacing them is outside this integration. No font is installed on the operating system, and the browser needs no external font stylesheet or CDN.

Before an update, retrieve the complete official stylesheet/fonts and licenses, preserve the intended families/weights/subsets, update provenance/digests and compare real browser loading and typography before/after. Run `npm run test:security` and the web build; inspect that every emitted font is present, unmodified, same-origin and accompanied by its license. The integrity regression checks all declared faces, binary digests and notices. Local browser comparison does not establish deployment or a remote security-scan result.
