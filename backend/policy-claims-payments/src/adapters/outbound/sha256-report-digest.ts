import { createHash } from 'node:crypto';
import type { ReportDigest } from '../../application/ports/claim-report';

export class Sha256ReportDigest implements ReportDigest {
  async sha256Hex(content: string): Promise<string> { return createHash('sha256').update(content).digest('hex'); }
}
