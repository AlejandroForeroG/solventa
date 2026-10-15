# Web entry and navigation

The public home page introduces Solventa's mortgage life calculator, lists the inputs needed and explains account and consent boundaries in es-CO and en-US. The primary link opens `/cotizar`, which renders the existing quote journey and its seven-step indicator. The shared logo returns to `/`. Native links support direct entry, reload and browser back navigation through the existing SPA asset fallback; no client router or new server route is required.

The landing creates no quote, reads no consent terms and submits no customer information. Session checking and the existing header sign-in/sign-out remain available. `/cotizar` retains the existing access, session recovery, quote and privacy states; an `auth=failed` return also opens that journey so its error remains visible. No OAuth callback, API contract, consent rule or contracting step changes in this increment.

A valid same-tab estimate draft also opens the journey at `/`, allowing the existing OAuth callback to resume the quote directly instead of showing the landing. The draft is still consumed only by the existing authenticated handoff. Root visits without a draft show the landing for signed-in visitors too; the primary link opens their protected quote form.

If session checking fails on the landing, a visible error offers a retry while the quote entry remains usable. The header shows sign-in only after confirming an anonymous session; loading or an unavailable session is not treated as anonymous. A successful retry restores the appropriate header action without leaving the landing.

See the [web guide](README.md) for quote, consent and privacy behavior. Validate entry, session failure/retry, OAuth return and locale/accessibility with the landing and public-quote suites in `npm run test:web`; use `npm run check` for the complete repository checks. Remote OAuth acceptance requires the deployed environment and a synthetic account; a frontend-only Vite preview cannot establish session or calculation success.
