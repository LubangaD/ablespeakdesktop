'use strict';

/**
 * Minimal image-dimension reader for PNG and JPEG — no dependencies.
 * Returns { width, height } in pixels, or throws if the format is unsupported.
 *
 * We only need width/height to (a) convert percentage-style model output to
 * pixels and (b) normalise click-distance error by the image diagonal.
 */

const fs = require('fs');

function pngSize(buf) {
  // PNG signature (8 bytes) + IHDR chunk: length(4) + "IHDR"(4) + width(4) + height(4)
  if (buf.length < 24) return null;
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI
  let off = 2;
  while (off + 9 < buf.length) {
    // Each marker starts with 0xFF; skip any fill bytes.
    if (buf[off] !== 0xff) { off++; continue; }
    let marker = buf[off + 1];
    off += 2;
    // Standalone markers without a length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (off + 1 >= buf.length) break;
    const segLen = buf.readUInt16BE(off);
    // SOF markers (0xC0–0xCF) except DHT(C4), JPG(C8), DAC(CC) carry frame dims.
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      // payload: precision(1) height(2) width(2) ...
      const height = buf.readUInt16BE(off + 3);
      const width = buf.readUInt16BE(off + 5);
      return { width, height };
    }
    off += segLen; // jump to next marker
  }
  return null;
}

function imageSizeFromBuffer(buf) {
  const png = pngSize(buf);
  if (png) return png;
  const jpg = jpegSize(buf);
  if (jpg) return jpg;
  throw new Error('Unsupported image format (only PNG and JPEG are supported)');
}

function imageSize(filePath) {
  return imageSizeFromBuffer(fs.readFileSync(filePath));
}

module.exports = { imageSize, imageSizeFromBuffer };
