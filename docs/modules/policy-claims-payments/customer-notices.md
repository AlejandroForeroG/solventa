# Customer notices

Code: `backend/policy-claims-payments` and `apps/mobile/src/features/notices`. A notice tells the native customer about a confirmed parametric payment, a policy modification/renewal/cancellation, an approaching expiry or a decided claim. Policy stores the business notices with their effects; its scheduled trigger stores expiry notices. The native client uses [v2 notices](../../../packages/contracts/openapi/v2/notices.yaml) with independent delivery state for each authenticated installation. The [examples](../../../packages/contracts/examples/notices.json) include one installation denying permission while another still receives the same event. The compatible legacy [v1 contract](../../../packages/contracts/openapi/v1/notices.yaml) remains available.

The transport is simulated. No push provider, device token or push service exists, and no external provider is contacted: the app collects the notices and presents them itself as local notifications. Solventa's authorization, the customer's choices, persistence, idempotency and the presentation on the device run for real. An offer to the device is never evidence that the customer saw a notice; only the receipt the device reports is.

## What is stored and what is not

A notice carries the policy identifier, its kind and its stored time, without amounts, documents, payment data or personal data. Ownership comes from the verified principal and stored notice. For v2, Identity also derives a canonical installation UUID from the existing active registration bound to that principal and verified WorkOS provider session. No caller-selected destination is accepted or returned. This is an authenticated installation binding, not hardware or biometric attestation; no real push provider is needed.

Delivery decisions, timestamps and receipts belong to that event and installation. A `permission_denied` receipt on one installation never suppresses another installation, and a `presented` receipt is not evidence for a different destination. Independent devices may each present the same event once for their own destination. Concurrent identical receipts for one destination replay; a different outcome conflicts only within that destination. The operating-system notification identifier remains the event UUID, so retries on one installation replace its existing notification rather than stacking it. A notice has one of these states:

| State | Meaning |
|---|---|
| `offered` | Handed to the device; no receipt yet. |
| `unconfirmed` | Offered more than ten minutes ago without a receipt, so its presentation is uncertain. It is offered again. |
| `presented` | The device reported that it showed the notice. |
| `permission_denied` | The device reported that the operating system did not allow it. |

A notice whose choice was off when it was read is recorded as suppressed and never offered, and turning the choice on later does not release it. Nothing is invented for a notice that was never stored.

No new table or migration is required. The existing `inbox_events` primary key is event plus consumer. V2 uses `notice.dispatch.v2:<installation-uuid>` with `offered` or `suppressed_preference`, and `notice.receipt.v2:<installation-uuid>` with `presented` or `permission_denied`; uniqueness rejects duplicate durable effects per destination. The owner-scoped SQL read joins only those exact consumer keys. Notices come from `outbox_events` by event type and owner, newest first, at most twenty from the last thirty days; claim notices use the subject-scoped source below. No dedicated notice-read index exists; the bounded query remains a volume limit.

Each new v2 decision commits its inbox effect, audit and historical capture together in one Policy SQL statement. The existing shared `decision-capture.v1.json` schema describes the capture: API v2, correlation, event/client/destination, category/kind, the actual push choice or reported receipt, stored-notice and verified-installation sources, and `native-notice-delivery` rule version `2`. Risk profiling consent is not required for this operation; current notification preferences remain a separate dispatch input. A receipt is explicitly client-reported, not platform attestation. The capture is retained in the existing outbox as `policy.notice.delivery.dispatch` or `policy.notice.delivery.receipt`; it is neither another customer notice nor evidence of delivery. Duplicate commands create no second audit/capture, and an audit or outbox failure rolls back the inbox write. No uncertain SQL commit is retried automatically.

## Routes

Both versions are native only and enter through the web Worker, which routes `/api/v1/notices` and `/api/v2/notices` to Policy with a 1 KiB body limit.

- `GET /api/v2/notices` authorizes `notices:read-device` with Identity. The same decision returns the verified destination and current push choices for its principal, so Policy still makes one internal call. A missing/invalid destination or missing choices fails closed with 503; a missing/revoked native binding is forbidden. Disabled preferences suppress this destination's notice; an offered but unpresented notice is withheld while its choice is off.
- `GET /api/v2/notices/{eventId}/destination` reauthorizes `notices:read-device` and resolves only a stored notice offered to this customer and installation. Missing, foreign, suppressed and never-offered events share an opaque 404. The response is a typed locator, not a URL or credentials: payment selects policy history, expiry selects renewal, lifecycle selects policy information, and claim status selects the customer claim case. The list keeps its existing six fields. Claim identifiers are selected from the subject-scoped notice source only for this protected query.
- `POST /api/v2/notices/{eventId}/receipt` authorizes `notices:receipt-device` and takes exactly one outcome, `presented` or `permission_denied`. The same outcome replays and a different one conflicts for this destination. A notice never offered to this installation conflicts; missing and foreign customer notices remain the same opaque 404. Adding a destination to the receipt body is invalid.

A cookie, a partner credential or a web session reaches neither route. Errors carry only `error` and `traceId`, with `Cache-Control: no-store`.

### Compatibility and rollout

V1 retains its original `notices:read`/`notices:receipt` session policy and customer-wide `notice.dispatch.v1`/`notice.receipt.v1` rows. No retirement date is assigned. Its receipt can still affect all v1 consumers; current native builds use v2. Legacy global rows are never deleted, rewritten or attributed to an installation without evidence. A retained event with no v2 receipt may therefore be re-offered once to each installation during rollout. V1 and v2 receipts are intentionally independent.

Publish Identity before Policy, then the mobile client. The expanded private access result is compatible with old Policy; new v2 Policy rejects an old Identity response without a destination rather than falling back to customer-wide state. Existing installations already register through the native authentication flow. A client without its active registration must recover through primary native login; the notices endpoint neither registers nor replaces a device. Runtime SQL roles and grants remain unchanged.

## Categories

| Notice | Preference category | Producer |
|---|---|---|
| Confirmed parametric payment | `payments` | The confirmation transaction of [parametric payouts](parametric-payouts.md#confirmation-and-the-customer-notice). |
| Policy modified, renewed or cancelled | `policy` | The lifecycle transaction of [policy lifecycle](policy-lifecycle.md). |
| Policy about to expire | `policy` | The scheduled trigger below. |
| A claim decided by an analyst (approved or rejected) | `claims` | The claim decision transaction, which already stores the customer's claim notice in `claim_notices`, addressed to the customer's subject. The native notice reads that row: it names only the policy of the claim, never the decision, the reason or the evidence. |

The `claims` category follows the claims choice of the preferences. Its notices are read from `claim_notices` by the customer's subject, which Identity returns with the same access decision, so a customer never sees a claim notice addressed to someone else and a request without the subject reads none. The delivery decision and the receipt use the same inbox rows as every other notice, keyed by the claim decision's event identifier. The `commercial` category has no notice and stays in the preference matrix without delivering anything.

### Expiry trigger

The Worker's `scheduled` handler runs `ExpiryNotices` every ten minutes, after the recoveries it already performs, and a failure there never blocks them. It stores one notice for each issued policy whose end is within seven days, using an event identifier derived from the policy and its expiry instant, so a second or concurrent run changes nothing. A policy that was already modified, renewed or cancelled is skipped. The run logs `expiry_notices` with the number announced.

## On the device

The app collects the notices when the customer is signed in, when it returns to the foreground and every minute while it is active. For each offered or unconfirmed notice it checks the operating system's permission; with permission it schedules a local notification, and without it reports `permission_denied`. It reports a receipt only after it is certain of the outcome. Scheduling a local notification only tells that the system accepted it, so `presented` is reported only once the system lists the notification among those on display; a notification that was merely scheduled, or that the system suppressed, reports nothing, stays offered and later becomes `unconfirmed`. A failed presentation is tried again, and a lost receipt is sent again. The notification identifier is the notice's own, so presenting it again replaces the earlier one instead of stacking a duplicate.

The text of the notification is generic ("Solventa", "You have a new notice. Open it to read it."), so a locked screen shows nothing about the policy, the amount or the person. Privacy rests on that text: on the Android emulator checked, the notification appeared in full on the lock screen, so no channel setting is relied on. Tapping it opens `/notice-action` with only the event UUID. That screen requires the native session; its explicit View details action fetches the destination anew before opening the same-environment system browser. A late response after an owner/session change is discarded. The notification contains no URL or business payload; malformed and legacy responses fall back to alerts. The browser independently checks its own session and resource ownership, retaining only a bounded locator through sign-in. Payment history displays the stored parametric indemnity separately from the premium; expiry selects the renewal form without submitting it. The alerts list uses the same action route. See the [mobile guide](../../channels/mobile/README.md#alerts-and-notices).

Push permission stays device-local and is never inferred from the stored choice, as described in [notification preferences](../identity-consent-ecosystem/notification-preferences.md).

## Verification and limits

`tests/notices.test.ts` runs the use case, the HTTP handler and the contract schemas with an in-memory copy of the store: offer once, suppression and withdrawal by choice, owner isolation, independent installation receipts, same-destination replay, preserved legacy history, the uncertain state, concurrent decisions and malformed stored notices. `tests/mobile-notices.test.ts` covers the coordinator and the v2 client. `tests/financial-access.test.ts` covers the verified destination, current choices and security denials. `npm run test:authentication:sql` verifies the destination lookup with real active, foreign, revoked and ambiguous session/installation bindings. `npm run test:financial:sql` repeats delivery on real SQL with the runtime grants, including independent permission outcomes, concurrent receipt replay, capture-schema validation, audit/outbox rollback, claim notices and the expiry trigger. The Pact of the native client is verified against the real handler and the gateway.

Run `npm run check`, both SQL suites above, mobile lint and mobile types. Then, in a native build, check the permission dialog, a presented notice, the lock screen, each category's authenticated destination, a denied permission and a signed-out tap. Use two independently authenticated installations of one synthetic customer: deny permission on one, present on the other and confirm their separate receipt states; repeat collection and verify there is no second presentation on the same installation. The web export cannot establish any of them.

Limits: transport is simulated and a closed app collects nothing until opened; legacy v1 retains customer-wide state and cannot establish destination-specific delivery; a v2 notice may legitimately appear on each independently authenticated installation; no commercial notice exists, and a claim notice reports a decision rather than every review step; missing receipts remain `unconfirmed`; the read has no dedicated index. Automated checks do not establish Android/iOS presentation, permission dialogs, lock-screen privacy or navigation; record those native runs separately.
