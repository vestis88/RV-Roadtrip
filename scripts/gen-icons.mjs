// One-off placeholder PWA icon generator (no external image deps available).
// Draws a simple rounded "RV" glyph on a brand-colored square PNG.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = makeTable())
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    crc = (crc >>> 8) ^ table[c]
  }
  return (crc ^ 0xffffffff) >>> 0
}
function makeTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function makePng(size, { bg, fg }) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const cx = size / 2
  const cy = size / 2
  const bodyW = size * 0.62
  const bodyH = size * 0.34
  const bodyX = cx - bodyW / 2
  const bodyY = cy - bodyH / 2 - size * 0.03
  const wheelR = size * 0.085
  const wheelY = bodyY + bodyH
  const wheel1X = bodyX + bodyW * 0.28
  const wheel2X = bodyX + bodyW * 0.78

  for (let y = 0; y < size; y++) {
    let rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < size; x++) {
      let r = bg[0]
      let g = bg[1]
      let b = bg[2]
      let a = 255

      const inBody =
        x >= bodyX && x <= bodyX + bodyW && y >= bodyY && y <= bodyY + bodyH
      const inCab =
        x >= bodyX + bodyW - bodyW * 0.28 &&
        x <= bodyX + bodyW &&
        y >= bodyY - bodyH * 0.35 &&
        y <= bodyY

      const dw1 = Math.hypot(x - wheel1X, y - wheelY)
      const dw2 = Math.hypot(x - wheel2X, y - wheelY)
      const inWheel = dw1 <= wheelR || dw2 <= wheelR

      if (inBody || inCab || inWheel) {
        r = fg[0]
        g = fg[1]
        b = fg[2]
      }

      const off = rowStart + 1 + x * 4
      raw[off] = r
      raw[off + 1] = g
      raw[off + 2] = b
      raw[off + 3] = a
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = deflateSync(raw)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const bg = [0x0f, 0x76, 0x4d] // deep green
const fg = [0xff, 0xff, 0xff]

writeFileSync('public/pwa-192.png', makePng(192, { bg, fg }))
writeFileSync('public/pwa-512.png', makePng(512, { bg, fg }))
writeFileSync('public/apple-touch-icon.png', makePng(180, { bg, fg }))
console.log('Generated PWA icons in public/')
