// 图标核验:解码 PNG(filter 0)→ ASCII 可视化 + 统计(底色/覆盖率/标记范围/安全区)
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(file) {
  const buf = readFileSync(file);
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4; // RGBA
  const stride = w * bpp + 1;
  const px = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y += 1) {
    const filter = raw[y * stride];
    if (filter !== 0) throw new Error('unexpected filter ' + filter);
    for (let x = 0; x < w * bpp; x += 1) px[y * w * bpp + x] = raw[y * stride + 1 + x];
  }
  return { w, h, bitDepth, colorType, px };
}

function luminance(px, i) {
  const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

for (const name of ['icon-512.png', 'icon-192.png', 'maskable-512.png']) {
  const { w, h, bitDepth, colorType, px } = decodePNG(`icons/${name}`);
  console.log(`\n=== ${name} ${w}x${h} depth=${bitDepth} colorType=${colorType} ===`);
  const at = (x, y) => Array.from(px.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
  console.log('四角:', at(0, 0).join(','), at(w - 1, 0).join(','), at(0, h - 1).join(','), at(w - 1, h - 1).join(','));
  // 标记范围(亮度 > 0.5 视为白)
  let minX = w, minY = h, maxX = 0, maxY = 0, whites = 0;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (luminance(px, (y * w + x) * 4) > 0.5) {
      whites += 1;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  console.log(`白色占比 ${(100 * whites / (w * h)).toFixed(1)}% | 标记范围 x ${minX}-${maxX}(${(100 * (maxX - minX) / w).toFixed(0)}%宽) y ${minY}-${maxY}(${(100 * (maxY - minY) / h).toFixed(0)}%高)`);
  if (name === 'maskable-512.png') {
    const cx = w / 2, cy = h / 2;
    let far = 0;
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      if (luminance(px, (y * w + x) * 4) > 0.5) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > far) far = d;
      }
    }
    console.log(`标记最远点半径 ${far.toFixed(0)}px,安全区半径 ${0.4 * w}px → ${far < 0.4 * w ? 'PASS' : 'FAIL'}`);
  }
  // ASCII 预览(采样 28 行)
  const rows = 28, cols = 28;
  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      const x = Math.floor((c + 0.5) * w / cols), y = Math.floor((r + 0.5) * h / rows);
      const L = luminance(px, (y * w + x) * 4);
      line += L > 0.75 ? '██' : L > 0.3 ? '▓▓' : '  ';
    }
    lines.push(line);
  }
  console.log(lines.join('\n'));
}
