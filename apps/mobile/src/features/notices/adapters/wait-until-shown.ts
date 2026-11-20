type Shown = { request: { identifier: string } };

// Scheduling a notification only tells that the system accepted it, not that it was shown: the system may suppress or fail it afterwards.
// A notice counts as presented only when the system lists it among the notifications on display, so a notice that was merely scheduled stays unconfirmed.
export async function waitUntilShown(
  shown: () => Promise<readonly Shown[]>,
  identifier: string,
  options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 300;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if ((await shown()).some(item => item.request.identifier === identifier)) return;
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error('notice_not_shown');
}
