/**
 * Generates the PWA icon set as real PNGs, with no image dependency.
 *
 * The mark is a rounded square in the app's accent green carrying three bars
 * of decreasing width -- a log, read at a glance at 48px on a home screen.
 * Shapes are rasterised at 4x and box-filtered down, which is enough
 * antialiasing for flat geometry.
 *
 * Run with `npm run icons`. The output is committed so a clean checkout can
 * build without running this.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const BG = [18, 21, 26] // --bg
const ACCENT = [74, 222, 128] // --accent
const INK = [6, 36, 15] // --accent-ink

const SS = 4 // supersampling factor

/** Signed-distance test for a rounded rectangle. */
function insideRoundRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius))
  const cy = Math.max(top + radius, Math.min(y, bottom - radius))
  const inCore = x >= left && x <= right && y >= top && y <= bottom
  if (!inCore) return false
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius + 1e-9
}

/**
 * Draws the icon at `size`, with `pad` fraction of blank margin around the
 * tile (maskable icons need the mark inside the safe zone).
 */
function drawIcon(size, { pad = 0, fullBleed = false } = {}) {
  const w = size * SS
  const acc = new Float64Array(w * w * 3)

  const margin = pad * w
  const tileLeft = margin
  const tileTop = margin
  const tileRight = w - margin
  const tileBottom = w - margin
  const tileSize = tileRight - tileLeft
  const tileRadius = fullBleed ? 0 : tileSize * 0.22

  // Three bars, decreasing width, vertically centred as a group.
  const barH = tileSize * 0.1
  const barGap = tileSize * 0.075
  const groupH = barH * 3 + barGap * 2
  const barTop0 = tileTop + (tileSize - groupH) / 2
  const barLeft = tileLeft + tileSize * 0.22
  const barWidths = [tileSize * 0.56, tileSize * 0.44, tileSize * 0.3]
  const barRadius = barH / 2

  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let color = BG

      const onTile = fullBleed
        ? true
        : insideRoundRect(px, py, tileLeft, tileTop, tileRight, tileBottom, tileRadius)

      if (onTile) {
        color = ACCENT
        for (let i = 0; i < 3; i++) {
          const top = barTop0 + i * (barH + barGap)
          if (
            insideRoundRect(px, py, barLeft, top, barLeft + barWidths[i], top + barH, barRadius)
          ) {
            color = INK
            break
          }
        }
      }

      const o = (y * w + x) * 3
      acc[o] = color[0]
      acc[o + 1] = color[1]
      acc[o + 2] = color[2]
    }
  }

  // Box-filter down to the requested size.
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * w + (x * SS + sx)) * 3
          r += acc[o]
          g += acc[o + 1]
          b += acc[o + 2]
        }
      }
      const n = SS * SS
      const o = (y * size + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = 255
    }
  }

  return out
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // One filter byte (0 = None) per scanline.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function write(name, size, options) {
  const png = encodePng(drawIcon(size, options), size)
  writeFileSync(resolve(OUT_DIR, name), png)
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`)
}

mkdirSync(OUT_DIR, { recursive: true })

write('favicon.png', 64)
write('icon-192.png', 192)
write('icon-512.png', 512)
write('apple-touch-icon.png', 180, { fullBleed: true })
// Maskable icons are cropped to a circle on some launchers, so the mark sits
// inside the 80% safe zone with the tile bled to the edges.
write('maskable-512.png', 512, { pad: 0.1, fullBleed: true })
