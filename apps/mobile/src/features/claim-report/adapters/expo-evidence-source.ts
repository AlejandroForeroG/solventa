import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import type { EvidenceCandidate } from '../domain/report';
import { isAppCopy } from './expo-evidence-files';
import type { CaptureOutcome, EvidenceSource } from '../application/ports';

const VIDEO_SECONDS = 30;
// Photos are compressed on capture so ten of them stay well inside the report's size limit.
const PHOTO_QUALITY = 0.8;

// The picker may report the size of the original while handing over a recompressed copy, and the server checks the size of the file it receives, so the
// copy itself is measured. The declared size is only a fallback; a file that cannot be read is reported as unreadable by the domain.
function sizeOf(uri: string, declared: number | undefined): number | null {
  try { const size = new File(uri).size; if (typeof size === 'number' && size > 0) return size; } catch { /* fall back to the declared size */ }
  return typeof declared === 'number' && declared > 0 ? declared : null;
}

function outcomeOf(result: ImagePicker.ImagePickerResult): CaptureOutcome {
  if (result.canceled) return { status: 'cancelled' };
  const candidates: EvidenceCandidate[] = result.assets.map(asset => ({ uri: asset.uri, mimeType: asset.mimeType ?? null, byteSize: sizeOf(asset.uri, asset.fileSize), owned: isAppCopy(asset.uri) }));
  return { status: 'ok', candidates };
}

// The camera needs an explicit runtime permission; the library does not, because the system photo picker only exposes what the customer selects.
async function withCamera(open: () => Promise<ImagePicker.ImagePickerResult>): Promise<CaptureOutcome> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { status: 'permission', permission: 'camera', canAskAgain: permission.canAskAgain };
    return outcomeOf(await open());
  } catch { return { status: 'failed' }; }
}

export function createExpoEvidenceSource(): EvidenceSource {
  return {
    takePhoto: () => withCamera(() => ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: PHOTO_QUALITY, exif: false })),
    recordVideo: () => withCamera(() => ImagePicker.launchCameraAsync({ mediaTypes: ['videos'], videoMaxDuration: VIDEO_SECONDS })),
    choose: async limit => {
      try {
        return outcomeOf(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true,
          selectionLimit: Math.max(1, limit), quality: PHOTO_QUALITY, exif: false }));
      } catch { return { status: 'failed' }; }
    },
  };
}
