# Customer notices

Code: `backend/policy-claims-payments` and `apps/mobile/src/features/notices`. A notice tells the native customer something about their own policy: a confirmed parametric payment, a change of policy (modified, renewed or cancelled) or a policy that is about to expire. Policy already stores the first two with the business effect that produced them (`policy.indemnity.notice`, `policy.lifecycle.notice`); a scheduled trigger stores the third (`policy.expiry.notice`). This guide describes how those stored notices reach the customer's device and what is recorded about it. The contract is [notices.yaml](../../../packages/contracts/openapi/v1/notices.yaml) and its [examples](../../../packages/contracts/examples/notices.json).

The transport is simulated. No push provider, device token or push service exists, and no external provider is contacted: the app collects the notices and presents them itself as local notifications. Solventa's authorization, the customer's choices, persistence, idempotency and the presentation on the device run for real. An offer to the device is never evidence that the customer saw a notice; only the receipt the device reports is.

## What is stored and what is not

A notice carries the policy identifier, its kind and the moment it was stored. It carries no amount, document, payment data or personal data. The owner is the client named inside the stored event, and the response never returns it. The state of a notice belongs to the customer, not to a device: there is no registry of notification devices, token or push provider yet, so the delivery decision and the receipt carry no installation. With several devices signed in to one account, the first receipt that is stored decides the durable state for all of them: once one reports `permission_denied`, the others do not present that notice even with permission, and once one reports `presented`, the others no longer receive it. That guarantee starts when the receipt is stored. Two devices that collect the notice before any receipt exists both receive it as `offered`, and each presents it before it reports, so both may show the notification; only the receipt that arrives second is answered as a conflict. A per-device state needs a registered device identity, which arrives with a real push provider, and is not part of this increment. A notice has one of these states:

| State | Meaning |
|---|---|
| `offered` | Handed to the device; no receipt yet. |
| `unconfirmed` | Offered more than ten minutes ago without a receipt, so its presentation is uncertain. It is offered again. |
| `presented` | The device reported that it showed the notice. |
| `permission_denied` | The device reported that the operating system did not allow it. |

A notice whose choice was off when it was read is recorded as suppressed and never offered, and turning the choice on later does not release it. Nothing is invented for a notice that was never stored.

No new table or migration exists. The delivery decision and the receipt are rows of the existing `inbox_events` table, keyed by event and consumer (`notice.dispatch.v1` with `offered` or `suppressed_preference`; `notice.receipt.v1` with `presented` or `permission_denied`), so a repeat records nothing twice. The notices are read from `outbox_events` by event type and by the client named in the stored payload, newest first, at most twenty from the last thirty days. That read has no dedicated index: it is bounded by the type filter, the window and the limit, which is enough for the volume of this scope and is a limit to revisit if the table grows.

## Routes

Both routes are native only and enter through the web Worker, which routes `/api/v1/notices` to Policy with a 1 KiB body limit.

- `GET /api/v1/notices` authorizes `notices:read` with Identity. The same Identity decision returns what the customer chose for push by category, read for the client that decision named, so Policy makes one call and never trusts an identifier from the request. Policy applies the choices before anything is offered: a choice that is off suppresses the notice, and a notice already offered but not presented is withdrawn while its choice is off. Without the choices in the decision nothing is offered and the answer is 503.
- `POST /api/v1/notices/{eventId}/receipt` authorizes `notices:receipt` and takes one outcome, `presented` or `permission_denied`. The same outcome again is a replay and a different one is a conflict. A notice that was never offered is a conflict, and a notice of another customer is the same 404 as one that does not exist.

A cookie, a partner credential or a web session reaches neither route. Errors carry only `error` and `traceId`, with `Cache-Control: no-store`.

## Categories

| Notice | Preference category | Producer |
|---|---|---|
| Confirmed parametric payment | `payments` | The confirmation transaction of [parametric payouts](parametric-payouts.md#confirmation-and-the-customer-notice). |
| Policy modified, renewed or cancelled | `policy` | The lifecycle transaction of [policy lifecycle](policy-lifecycle.md). |
| Policy about to expire | `policy` | The scheduled trigger below. |

The `claims` category of the preferences has no notice yet: a change of claim status depends on the claim decisions, which are not part of this scope, and no producer exists for it. The `commercial` category has none either. Both stay in the preference matrix without delivering anything.

### Expiry trigger

The Worker's `scheduled` handler runs `ExpiryNotices` every ten minutes, after the recoveries it already performs, and a failure there never blocks them. It stores one notice for each issued policy whose end is within seven days, using an event identifier derived from the policy and its expiry instant, so a second or concurrent run changes nothing. A policy that was already modified, renewed or cancelled is skipped. The run logs `expiry_notices` with the number announced.

## On the device

The app collects the notices when the customer is signed in, when it returns to the foreground and every minute while it is active. For each offered or unconfirmed notice it checks the operating system's permission; with permission it schedules a local notification, and without it reports `permission_denied`. It reports a receipt only after it is certain of the outcome. Scheduling a local notification only tells that the system accepted it, so `presented` is reported only once the system lists the notification among those on display; a notification that was merely scheduled, or that the system suppressed, reports nothing, stays offered and later becomes `unconfirmed`. A failed presentation is tried again, and a lost receipt is sent again. The notification identifier is the notice's own, so presenting it again replaces the earlier one instead of stacking a duplicate.

The text of the notification is generic ("Solventa", "You have a new notice. Open it to read it."), so a locked screen shows nothing about the policy, the amount or the person. Privacy rests on that text: on the Android emulator checked, the notification appeared in full on the lock screen, so no channel setting is relied on. Tapping it opens the alerts, which ask for the session again; a notice is never an authorization. The alerts screen lists what the server returned with its state, and each entry opens the wallet. See the [mobile guide](../../channels/mobile/README.md#alerts-and-notices).

Push permission stays device-local and is never inferred from the stored choice, as described in [notification preferences](../identity-consent-ecosystem/notification-preferences.md).

## Verification and limits

`tests/notices.test.ts` runs the use case, the HTTP handler and the contract schemas with an in-memory copy of the store: offer once, suppression and withdrawal by choice, owner isolation, receipts, the uncertain state, concurrent decisions and malformed stored notices. `tests/mobile-notices.test.ts` covers the coordinator and the client. `tests/financial-access.test.ts` covers the Identity decision. `npm run test:financial:sql` repeats the delivery on real SQL with the runtime grants, including the expiry trigger. The Pact of the native client is verified against the real handler and the gateway.

Run `npm run check` and `npm run test:financial:sql`. Then, in a native development build, check the permission dialog, a presented notice, the lock screen, a tap that opens the alerts, a denied permission and a signed-out tap. The web export cannot establish any of them.

Limits: the transport is simulated and a closed app collects nothing until it is opened; the state of a notice is per customer, the first stored receipt decides it across devices, and a notice collected by two devices before that receipt may be shown on both; no claim-status or commercial notice exists; a notice offered to a device that never reports back stays `unconfirmed`; the notice read has no dedicated index; and iOS and a physical device are not exercised.
