// scripts/gen-icons.mjs — App 图标生成器(纯 Node,零依赖:zlib + CRC32 + 4x 超采样栅格化)。
// 设计:经典 THS 蓝纯底 #1a4a9c + 三根白色递升蜡烛(全实心、带影线),Binance/OKX 式单一粗壮标记纪律。
// 用法:node scripts/gen-icons.mjs → 覆盖 icons/icon-192.png / icon-512.png / maskable-512.png(同名替换,SW 发版自动刷新)。
// maskable 版:同标记缩放到 75% 居中,角落半径 161 < 安全区半径 205(=40%×512),全出血蓝底。
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BG = [0x1a, 0x4a, 0x9c]; // 经典 THS 蓝,与 theme_color / 顶栏渐变起点一致
const FG = [0xff, 0xff, 0xff]; // 纯白蜡烛

// ---- PNG 编码(RGBA8,filter 0,zlib) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0
    rgba.copy ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- 标记几何(512 设计坐标):三根递升白色实心蜡烛 + 影线 ----
// 蜡烛宽 76、间距 42;底部递升(356/330/300)、顶部递升更陡(280/216/140)——上升势能;
// 影线宽 22,上下各伸出 32。
const CANDLES = [
  { body: [100, 280, 176, 356], wick: [138, 248, 160, 388] },
  { body: [218, 216, 294, 330], wick: [256, 184, 278, 362] },
  { body: [336, 140, 412, 300], wick: [374, 108, 396, 332] }
];
function insideRect(x, y, r) { return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]; }
function isMark(x, y, scale, cx, cy) {
  // 以 (cx,cy) 为中心缩放 scale 后的标记命中测试
  const tx = cx + (x - cx) / scale;
  const ty = cy + (y - cy) / scale;
  for (const c of CANDLES) if (insideRect(tx, ty, c.body) || insideRect(tx, ty, c.wick)) return true;
  return false;
}

// ---- 渲染(SS=4 超采样,coverage 抗锯齿) ----
function render(size, scale) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          // 子像素映射到 512 设计坐标系
          const dx = ((x + (sx + 0.5) / SS) / size) * 512;
          const dy = ((y + (sy + 0.5) / SS) / size) * 512;
          if (isMark(dx, dy, scale, 256, 256)) hit += 1;
        }
      }
      const cov = hit / (SS * SS);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(BG[0] * (1 - cov) + FG[0] * cov);
      rgba[i + 1] = Math.round(BG[1] * (1 - cov) + FG[1] * cov);
      rgba[i + 2] = Math.round(BG[2] * (1 - cov) + FG[2] * cov);
      rgba[i + 3] = 255; // 全出血不透明(iOS 自裁圆角 / Android maskable 均安全)
    }
  }
  return rgba;
}

function emit(name, size, scale) {
  const file = path.join(ROOT, 'icons', name);
  writeFileSync(file, encodePNG(size, size, render(size, scale)));
  console.log(`  ${name}: ${size}x${size} scale=${scale} -> ${file}`);
}

console.log('生成 MarketPulse App 图标(蓝底白蜡烛):');
emit('icon-192.png', 192, 1);          // purpose any:标记占宽 61%
emit('icon-512.png', 512, 1);
emit('maskable-512.png', 512, 0.75);   // purpose maskable:角落半径 161 < 安全区 205
console.log('完成。');
