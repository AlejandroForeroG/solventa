import type { ClaimEvidenceStore, EvidencePut } from '../../application/ports/claim-report';

// R2 verifies the declared SHA-256 while it receives the stream and refuses the object on a mismatch (error 10037), so a corrupted upload is never stored.
export class R2ClaimEvidence implements ClaimEvidenceStore<ReadableStream<Uint8Array>> {
  constructor(private readonly bucket: R2Bucket) {}
  async put(key: string, body: ReadableStream<Uint8Array>, meta: { contentType: string; byteSize: number; sha256: string }): Promise<EvidencePut> {
    try {
      await this.bucket.put(key, body, { sha256: meta.sha256, httpMetadata: { contentType: meta.contentType } });
    } catch (error) {
      if (error instanceof Error && /\b10037\b|sha-?256/i.test(error.message)) return 'checksum_mismatch';
      throw error;
    }
    const stored = await this.bucket.head(key);
    return stored?.size === meta.byteSize ? 'stored' : 'size_mismatch';
  }
}
