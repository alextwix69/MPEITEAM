import sharp from 'sharp';
import { ApplicationError } from '../../../platform/http/application-error';
import type { MalwareScanner } from '../application/malware-scanner.port';
import type { SanitizedImage } from '../files.types';

const MAX_INPUT_PIXELS = 20_000_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function detectedMime(body: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    body.length >= 8 &&
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).equals(body.subarray(0, 8))
  ) {
    return 'image/png';
  }
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export async function sanitizeImage(
  body: Buffer,
  expectedMime: string,
  scanner: MalwareScanner,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<SanitizedImage> {
  const actualMime = detectedMime(body);
  if (!actualMime || actualMime !== expectedMime) {
    throw new ApplicationError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Файл не является поддерживаемым изображением JPEG, PNG или WebP.',
      415,
    );
  }
  if ((await scanner.scan(body)) === 'malware') {
    throw new ApplicationError(
      'MEDIA_MALWARE_DETECTED',
      'Файл не прошёл проверку безопасности и не будет доставлен.',
      422,
    );
  }

  let width = 1920;
  let height = 1080;
  let quality = 82;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const result = await sharp(body, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width, height, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (result.data.length <= maxOutputBytes) {
        return {
          body: result.data,
          mime: 'image/jpeg',
          sizeBytes: result.data.length,
          width: result.info.width,
          height: result.info.height,
        };
      }
      if (quality > 45) quality -= 8;
      else {
        width = Math.max(320, Math.floor(width * 0.8));
        height = Math.max(180, Math.floor(height * 0.8));
      }
    } catch {
      throw new ApplicationError(
        'MEDIA_PROCESSING_FAILED',
        'Изображение не удалось безопасно обработать. Выберите другой файл.',
        422,
      );
    }
  }
  throw new ApplicationError(
    'MEDIA_PROCESSING_FAILED',
    'Изображение не удалось привести к допустимым параметрам.',
    422,
  );
}

export { detectedMime, MAX_INPUT_PIXELS, MAX_OUTPUT_BYTES };
