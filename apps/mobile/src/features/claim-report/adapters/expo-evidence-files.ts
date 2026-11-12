import { File, Paths } from 'expo-file-system';
import { getThumbnailAsync } from 'expo-video-thumbnails';
import type { EvidenceFiles } from '../application/ports';

// The picker and the thumbnail generator write copies into the app cache. Only a path inside it is an app copy: a gallery original never is.
export function isAppCopy(uri: string): boolean {
  try { return uri.startsWith(Paths.cache.uri) && !uri.includes('/../'); } catch { return false; }
}

export const expoEvidenceFiles: EvidenceFiles = {
  async thumbnail(uri) {
    // A moment after the start avoids a black first frame; a very short clip falls back to its first frame.
    for (const time of [1000, 0]) {
      try { return (await getThumbnailAsync(uri, { time, quality: 0.5 })).uri; } catch { /* try the next instant */ }
    }
    return null;
  },
  async dispose(uris) {
    for (const uri of uris) {
      if (!isAppCopy(uri)) continue;
      // Deleting is best effort: a copy that cannot be removed is left to the system, which evicts the cache.
      try { const file = new File(uri); if (file.exists) file.delete(); } catch { /* left to the system */ }
    }
  },
};
