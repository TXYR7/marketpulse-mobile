// scripts/gen-icons.mjs — App 图标生成器(纯 Node,零依赖:zlib + CRC32 + 4x 超采样栅格化)。
// 设计:v34 宇宙星空风(与应用本体 styles.css 深空层同源)——近黑深空底 + 稀疏真实色温星海,
// 三根递升蜡烛:白色边框 + 内里银河填充(银心暖奶油→紫→冷蓝→HII 粉红,内嵌星点),影线纯白。
// 用法:node scripts/gen-icons.mjs → 覆盖 icons/icon-192.png / icon-512.png / maskable-512.png(同名替换,SW 发版自动刷新)。
// maskable 版:同标记缩放到 75% 居中,角落半径 161 < 安全区半径 205(=40%×512),全出血深空底。
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---- 调色板(与应用 styles.css 宇宙星空层同源) ----
const SPACE = [4, 6, 11]; // 深空底 #04060b
const WHITE = [255, 255, 255];
// 银河带四停:银心暖奶油 → 紫 → 冷蓝 → HII 粉红
const GALAXY_STOPS = [
  [255, 233, 196], // 银心暖奶油
  [148, 103, 235], // 紫
  [94, 128, 240], // 冷蓝(反银心方向)
  [255, 138, 180] // HII 电离氢粉红
];
// 背景星云辉光(极淡,只给底一点宇宙感):位置/半径/颜色/透明度
const NEBULAE = [
  { x: 130, y: 120, r: 200, c: [255, 233, 196], a: 0.07 }, // 银心端暖辉
  { x: 340, y: 300, r: 190, c: [148, 163, 234], a: 0.06 }, // 冷蓝辉
  { x: 240, y: 400, r: 120, c: [255, 138, 158], a: 0.05 } // HII 粉辉
];
// 星光谱:70% A 型白 / 20% B 型蓝白 / 10% K 型红巨星
const SPECTRA = [
  { c: [235, 240, 255], w: 0.7 },
  { c: [160, 190, 255], w: 0.2 },
  { c: [255, 160, 130], w: 0.1 }
];

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

// ---- 标记几何(512 设计坐标):三根递升蜡烛(白边框+银河填充)+ 纯白影线 ----
// 蜡烛宽 76、间距 42;底部递升(356/330/300)、顶部递升更陡(280/216/140)——上升势能;
// 影线宽 22,上下各伸出 32。边框厚 9。
// 影线宽 22,上下各伸出 32,水平居中于实体中线(2026-09-08 评审批修:旧 wick 全部右偏 +11px 且先于实体绘制,
// 22px 白影线盖在银河填充上贯穿实体,把主视觉吃掉一半成不对称 H 形)。边框厚 9。
const BORDER = 9;
const CANDLES = [
  { body: [100, 280, 176, 356], wick: [127, 248, 149, 388] },
  { body: [218, 216, 294, 330], wick: [245, 184, 267, 362] },
  { body: [336, 140, 412, 300], wick: [363, 108, 385, 332] }
];
function insideRect(x, y, r) { return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]; }
function candleAt(x, y) {
  for (let i = 0; i < CANDLES.length; i += 1) {
    const c = CANDLES[i];
    // 先判实体再判影线:实体覆盖影线(标准蜡烛图画法),影线只在实体上下段露出
    if (insideRect(x, y, c.body)) {
      const edge = Math.min(x - c.body[0], c.body[2] - x, y - c.body[1], c.body[3] - y);
      return { i, part: edge <= BORDER ? 'border' : 'fill' };
    }
    if (insideRect(x, y, c.wick)) return { i, part: 'wick' };
  }
  return null;
}

// ---- 银河填充:蜡烛体内对角渐变(银心暖→紫→冷蓝→HII 粉)+ 云带亮度调制 + 内嵌星点 ----
function lerp(a, b, t) { return a + (b - a) * t; }
function mixC(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
function galaxyFill(c, x, y) {
  const b = c.body;
  const t = Math.min(0.999, Math.max(0, ((x - b[0]) / (b[2] - b[0]) + (y - b[1]) / (b[3] - b[1])) / 2));
  const pos = t * (GALAXY_STOPS.length - 1);
  const s = Math.floor(pos);
  let col = mixC(GALAXY_STOPS[s], GALAXY_STOPS[Math.min(s + 1, GALAXY_STOPS.length - 1)], pos - s);
  // 云带:沿对角正弦微调亮度,给银河一点絮状层次
  const band = 0.88 + 0.16 * Math.sin((x + y) / 13 + c.body[0] / 9);
  col = [col[0] * band, col[1] * band, col[2] * band];
  // 内嵌星点:每根蜡烛 2 颗(哈希确定性),亮白小点
  for (let k = 0; k < 2; k += 1) {
    const h = hash3(c.body[0] + k * 97, c.body[1] + k * 57, k + 3);
    const sx = b[0] + BORDER + 6 + h * 0.72 * (b[2] - b[0]);
    const sy = b[1] + BORDER + 6 + hash3(k + 11, c.body[1], c.body[2]) * 0.72 * (b[3] - b[1]);
    const d = Math.hypot(x - sx, y - sy);
    if (d < 2.6) { col = mixC(col, WHITE, 1 - d / 2.6); }
  }
  return col;
}

// ---- 确定性哈希星海(背景) ----
function hash3(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}
function pickSpectrum(u) {
  let acc = 0;
  for (const s of SPECTRA) { acc += s.w; if (u < acc) return s.c; }
  return SPECTRA[0].c;
}
// 32px 网格,每格 ~22% 概率一颗星;返回该点最近星的亮度贡献(0=无)
function starAt(x, y) {
  const CELL = 32;
  let best = 0, starC = null;
  for (let gx = -1; gx <= 1; gx += 1) {
    for (let gy = -1; gy <= 1; gy += 1) {
      const cx = Math.floor(x / CELL) + gx, cy = Math.floor(y / CELL) + gy;
      const h1 = hash3(cx, cy, 1);
      if (h1 > 0.22) continue; // 该格无星
      const sx = cx * CELL + hash3(cx, cy, 2) * CELL;
      const sy = cy * CELL + hash3(cx, cy, 3) * CELL;
      const r = 0.7 + hash3(cx, cy, 4) * 1.1; // 半径 0.7~1.8
      const d = Math.hypot(x - sx, y - sy);
      if (d < r) {
        const b = (1 - d / r) * (0.25 + 0.65 * hash3(cx, cy, 5));
        if (b > best) { best = b; starC = pickSpectrum(hash3(cx, cy, 6)); }
      }
    }
  }
  return { b: best, c: starC };
}

// ---- 背景:深空底 + 极淡星云辉光 + 星海(标记绘制在其上) ----
function backgroundAt(x, y) {
  let col = [SPACE[0], SPACE[1], SPACE[2]];
  for (const n of NEBULAE) {
    const d = Math.hypot(x - n.x, y - n.y);
    if (d < n.r) {
      const t = (1 - d / n.r) * n.a;
      col = mixC(col, n.c, t);
    }
  }
  const { b, c } = starAt(x, y);
  if (b > 0) col = mixC(col, c, b);
  return col;
}

// ---- 逐子像素取色:标记(以 256,256 为中心缩放)覆盖背景 ----
function colorAt(x, y, scale, cx, cy) {
  const hit = candleAt(cx + (x - cx) / scale, cy + (y - cy) / scale);
  if (!hit) return backgroundAt(x, y);
  if (hit.part === 'wick' || hit.part === 'border') return WHITE;
  return galaxyFill(CANDLES[hit.i], cx + (x - cx) / scale, cy + (y - cy) / scale);
}

// ---- 渲染(SS=4 超采样,逐子像素颜色平均抗锯齿) ----
function render(size, scale) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          // 子像素映射到 512 设计坐标系
          const c = colorAt(((x + (sx + 0.5) / SS) / size) * 512, ((y + (sy + 0.5) / SS) / size) * 512, scale, 256, 256);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / (SS * SS));
      rgba[i + 1] = Math.round(g / (SS * SS));
      rgba[i + 2] = Math.round(b / (SS * SS));
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

console.log('生成 MarketPulse App 图标(深空底+白边框银河蜡烛):');
emit('icon-192.png', 192, 1);          // purpose any:标记占宽 61%
emit('icon-512.png', 512, 1);
emit('maskable-512.png', 512, 0.75);   // purpose maskable:角落半径 161 < 安全区 205
console.log('完成。');
