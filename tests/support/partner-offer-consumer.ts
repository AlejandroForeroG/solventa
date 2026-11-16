// A partner's server as the contract describes it: it holds an M2M token and an authorization id given by the
// customer, and calls the public gateway. It never sends a customer identifier.
export class PartnerOfferConsumer {
  constructor(private readonly gateway: (request: Request) => Promise<Response>, private readonly token: () => Promise<string>) {}

  async requestOffer(input: { authorizationId: unknown; idempotencyKey: string | null; quote: Record<string, unknown>; token?: string | null; extra?: Record<string, unknown> }) {
    const token = input.token === undefined ? await this.token() : input.token;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (input.idempotencyKey !== null) headers['idempotency-key'] = input.idempotencyKey;
    const response = await this.gateway(new Request('https://solventa.test/api/v1/partner/offers', {
      method: 'POST', headers, body: JSON.stringify({ authorizationId: input.authorizationId, ...input.quote, ...input.extra }) }));
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
  }
}
