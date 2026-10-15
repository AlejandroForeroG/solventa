import type { AlertDelivery, SecurityAlert } from '../../application/ports/security-alerts';
import { canonicalSecurityAlertProjection } from '../../application/security-alerts';

type Environment = 'local' | 'dev' | 'staging' | 'prod';
type StartDeadline = (expire: () => void, milliseconds: number) => () => void;
const defaultDeadline: StartDeadline = (expire, milliseconds) => {
  const timer = setTimeout(expire, milliseconds);
  return () => clearTimeout(timer);
};
const address = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;

export class CloudflareEmailDelivery implements AlertDelivery {
  private readonly config: { from: string; to: string; environment: Environment };
  constructor(private readonly email: Pick<SendEmail, 'send'>,
    config: { from: string; to: string; environment: Environment },
    private readonly startDeadline: StartDeadline = defaultDeadline) {
    const { from, to, environment } = config;
    if (![from, to].every(value => typeof value === 'string' && value.length <= 254 && address.test(value))
      || !['local', 'dev', 'staging', 'prod'].includes(environment)) {
      throw new Error('invalid_security_alert_email_configuration');
    }
    this.config = { from, to, environment };
  }

  async deliver(input: SecurityAlert): Promise<{ accepted: true } | { accepted: false; retryable: boolean }> {
    const alert = canonicalSecurityAlertProjection(input);
    if (!alert) return { accepted: false, retryable: false };
    // Build only the canonical projection; never serialize the caller object, capture or provider error.
    const text = [
      'Solventa security denial', `Environment: ${this.config.environment}`,
      `Event ID: ${alert.eventId}`, `Decision ID: ${alert.decisionId}`, `Correlation ID: ${alert.correlationId}`,
      `Occurred at: ${alert.occurredAt}`, `Category: ${alert.category}`, `Channel: ${alert.channel}`,
      `Operation: ${alert.operation}`, `Cause: ${alert.cause}`,
      'Delivery is at least once. Repeated messages with the same Event ID refer to the same event.',
    ].join('\n');
    const message = { from: this.config.from, to: this.config.to,
      subject: `Solventa security denial [${this.config.environment}] ${alert.eventId}`,
      text, html: `<pre>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>` };
    let cancelDeadline = () => {};
    const expired = new Promise<{ accepted: false; retryable: true }>(resolve => {
      cancelDeadline = this.startDeadline(() => resolve({ accepted: false, retryable: true }), 3_000);
    });
    try {
      // The binding exposes no cancellation signal. Timeout means acknowledgement unknown,
      // never definitive failure of the external effect; a retry can send a duplicate.
      const sending = Promise.resolve().then(() => this.email.send(message)).then(receipt => (
        receipt && typeof receipt.messageId === 'string' && /^[!-~]{1,256}$/.test(receipt.messageId)
          ? { accepted: true as const } : { accepted: false as const, retryable: true }
      ), () => ({ accepted: false as const, retryable: true }));
      return await Promise.race([sending, expired]);
    } finally { cancelDeadline(); }
  }
}
