import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';
import { createUploadTask, FileSystemUploadType } from 'expo-file-system/legacy';
import type { FileDigest } from '../application/ports';
import type { EvidenceUploader } from './claim-report-api';

// The report holds at most 50 MiB, so one file is read into memory only to hash it. The file is never sent from that copy.
export const expoFileDigest: FileDigest = {
  async sha256(uri) {
    // The native digest takes a typed array; a bare ArrayBuffer is rejected by the bridge.
    const hash = await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(await new File(uri).arrayBuffer()));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  },
};

// The native layer streams the file body from its path with a known length, which the gateway requires.
// An aborted signal cancels the native transfer, and so does any failure: Expo keeps its progress subscription, and with it the task, until the
// transfer succeeds or is cancelled, so every attempt that does not succeed cancels its task and waits for that before it ends.
export const expoEvidenceUploader: EvidenceUploader = async ({ url, uri, contentType, token, signal }) => {
  const task = createUploadTask(url, uri, {
    httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, Accept: 'application/json' },
  });
  let stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= task.cancelAsync().catch(() => undefined));
  const onAbort = () => { void stop(); };
  signal.addEventListener('abort', onAbort, { once: true });
  let succeeded = false;
  try {
    if (signal.aborted) void stop();
    const result = await task.uploadAsync();
    if (!result) throw new Error('The upload was cancelled before it finished.');
    succeeded = true;
    return { status: result.status, body: result.body };
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!succeeded) await stop();
  }
};
