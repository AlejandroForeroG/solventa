import { CryptoDigestAlgorithm, digest, getRandomValues } from 'expo-crypto';
import { polyfillWebCrypto } from 'expo-standard-web-crypto';

polyfillWebCrypto();
// The standard polyfill falls back to Math.random on native errors. PKCE must fail closed.
Object.defineProperty(globalThis.crypto, 'getRandomValues', { configurable: true, value: getRandomValues });
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    value: {
      digest(algorithm: string, data: BufferSource) {
        if (algorithm !== 'SHA-256') throw new Error('Unsupported PKCE digest');
        return digest(CryptoDigestAlgorithm.SHA256, data);
      },
    },
  });
}
