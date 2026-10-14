const QRCode = require('qrcode');
const { PNG } = require('pngjs');

const IMAGE_LIMIT = 1024 * 1024;
const RAW_LIMIT = 2000;

// Only embedded images reach the browser. Never fetch a QR URL or put pairing
// material into a URL, filename, log, or persistent store.
function localWhatsappQr(value = '') {
  if (typeof value !== 'string') return null;
  const content = value.trim();
  if (!content || content.length > IMAGE_LIMIT) return null;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(content)) return content;
  if (/^(?:data:|(?:https?:)?\/\/)/i.test(content)) return null;

  // Some Evolution variants provide a PNG/JPEG/WebP without its data prefix.
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(content)) {
    const bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
    if (mime) return `data:image/${mime};base64,${bytes.toString('base64')}`;
  }
  if (Buffer.byteLength(content, 'utf8') > RAW_LIMIT) return null;
  try {
    const { modules } = QRCode.create(content, { errorCorrectionLevel: 'M' });
    const scale = 4, margin = 4, side = (modules.size + margin * 2) * scale;
    const data = Buffer.alloc(side * side * 4, 255);
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (!modules.get(row, col)) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const offset = (((row + margin) * scale + dy) * side + (col + margin) * scale + dx) * 4;
            data[offset] = data[offset + 1] = data[offset + 2] = 0;
          }
        }
      }
    }
    const png = PNG.sync.write({ width: side, height: side, data });
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    // Provider content and encoder errors can contain pairing material.
    return null;
  }
}

module.exports = { localWhatsappQr };
