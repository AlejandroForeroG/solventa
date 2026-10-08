# IBM Plex web fonts

Unmodified complete WOFF2 files from IBM's published npm packages:

- `@ibm/plex-sans@1.1.0`: Regular (400), Medium (500), SemiBold (600), Bold (700).
- `@ibm/plex-mono@2.5.0`: Regular (400), SemiBold (600).

Upstream: [IBM Plex](https://github.com/IBM/plex). All included files are distributed under the [SIL Open Font License 1.1](LICENSE.txt), including IBM's copyright and reserved font name. Both source packages carry the same license text. Preserve the license and unmodified filenames when updating these assets.

The API reference build copies these shared assets and the license to its same-origin `fonts/` directory. The viewer declares them with `@font-face` and `font-display: swap`; it requires neither locally installed fonts nor a font CDN. To update, obtain explicit package versions from the official registry, copy the required complete WOFF2 files and license together, run the documentation/route tests and full check, and verify actual browser font loading in dev before promotion.
