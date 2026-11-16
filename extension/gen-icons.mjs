#!/usr/bin/env node
/**
 * 生成扩展图标 PNG（纯 Node，零依赖）。
 * 设计：暖金色圆角底 + 白色书签轮廓，简洁辨识度高。
 * 用法：node gen-icons.mjs  （在 extension/ 目录下）
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'icons');
mkdirSync(OUT, { recursive: true });

/* ---------- 极简 PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 画布辅助 ---------- */
function makeCanvas(size) {
  return { size, px: new Uint8Array(size * size * 4) };
}
function setPx(c, x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  // alpha 混合到现有像素
  const na = a / 255;
  c.px[i] = Math.round(c.px[i] * (1 - na) + r * na);
  c.px[i + 1] = Math.round(c.px[i + 1] * (1 - na) + g * na);
  c.px[i + 2] = Math.round(c.px[i + 2] * (1 - na) + b * na);
  c.px[i + 3] = Math.min(255, c.px[i + 3] + a);
}

/** 圆角矩形：背景圆角底色 */
function fillRoundRect(c, x0, y0, x1, y1, radius, color) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // 圆角判断：四个角的圆弧内
      const nx = x < x0 + radius ? x0 + radius : x > x1 - radius ? x1 - radius : x;
      const ny = y < y0 + radius ? y0 + radius : y > y1 - radius ? y1 - radius : y;
      const dx = x - nx, dy = y - ny;
      if (dx * dx + dy * dy <= radius * radius) setPx(c, x, y, color);
    }
  }
}

/** 书签形状（上下两段） */
function fillBookmarkShape(c, cx, topY, bottomY, w, color) {
  const half = Math.floor(w / 2);
  const notchH = Math.floor((bottomY - topY) * 0.22); // 底部 V 形缺口高度
  for (let y = topY; y <= bottomY; y++) {
    const t = (y - topY) / (bottomY - topY);
    // 上半部矩形，下半部渐窄 + V 缺口
    let halfW = half;
    if (t > 0.72) {
      // 底部收窄
      const shrink = (t - 0.72) / 0.28 * half * 0.55;
      halfW = Math.max(2, half - Math.round(shrink));
    }
    for (let x = cx - halfW; x <= cx + halfW; x++) {
      // V 形缺口：底部中间挖空
      const distFromBottom = bottomY - y;
      if (distFromBottom < notchH) {
        const notchHalf = Math.round((distFromBottom / notchH) * halfW * 0.42);
        if (x >= cx - notchHalf && x <= cx + notchHalf) continue;
      }
      setPx(c, x, y, color);
    }
  }
}

/** 用 NxN 像素直接画（128 底图） */
function drawIcon(size128) {
  // 圆角背景：暖金渐变（上深下浅），白色书签形状
  const r0 = 0x8a, g0 = 0x55, b0 = 0x0a;   // #A16207 深
  const r1 = 0xe3, g1 = 0xa9, b1 = 0x4c;   // #E3A94C 浅
  const c2 = makeCanvas(128);
  // 用渐变填充圆角矩形主体
  for (let y = 3; y <= 124; y++) {
    const t = (y - 3) / 121;
    const rr = Math.round(r0 + (r1 - r0) * t);
    const gg = Math.round(g0 + (g1 - g0) * t);
    const bb = Math.round(b0 + (b1 - b0) * t);
    for (let x = 3; x <= 124; x++) {
      const inside = roundRectInside(x, y, 3, 3, 124, 124, 24);
      if (inside) setPx(c2, x, y, [rr, gg, bb]);
    }
  }
  // 书签白色形状
  fillBookmarkShape(c2, 64, 26, 100, 44, [255, 255, 255, 245]);
  return c2.px;
}

function roundRectInside(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  const nx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const ny = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - nx, dy = y - ny;
  return dx * dx + dy * dy <= r * r;
}

/** 双线性缩放到目标尺寸 */
function scaleNearest(src128, size) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor(x * 128 / size);
      const sy = Math.floor(y * 128 / size);
      const si = (sy * 128 + sx) * 4;
      const oi = (y * size + x) * 4;
      out[oi] = src128[si];
      out[oi + 1] = src128[si + 1];
      out[oi + 2] = src128[si + 2];
      out[oi + 3] = src128[si + 3];
    }
  }
  return out;
}

/* ---------- 生成各尺寸 ---------- */
const base128 = drawIcon(128);

for (const size of [16, 32, 48, 128]) {
  const px = size === 128 ? base128 : scaleNearest(base128, size);
  const png = encodePNG(size, size, Buffer.from(px));
  const f = join(OUT, `icon${size}.png`);
  writeFileSync(f, png);
  console.log(`✓ ${f} (${png.length} bytes)`);
}