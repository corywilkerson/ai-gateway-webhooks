/**
 * Sniff a content type from a file's magic bytes (the first 16 are enough
 * for every format here). Returns null when nothing matches.
 */
export function detectContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (
    readAscii(bytes, 0, 6) === "GIF87a" ||
    readAscii(bytes, 0, 6) === "GIF89a"
  ) {
    return "image/gif";
  }

  if (readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }

  if (readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WAVE") {
    return "audio/wav";
  }

  if (readAscii(bytes, 0, 4) === "OggS") {
    return "audio/ogg";
  }

  if (readAscii(bytes, 0, 4) === "fLaC") {
    return "audio/flac";
  }

  if (readAscii(bytes, 0, 3) === "ID3" || isMp3Frame(bytes)) {
    return "audio/mpeg";
  }

  if (readAscii(bytes, 4, 4) === "ftyp") {
    return "video/mp4";
  }

  return null;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function isMp3Frame(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0;
}
