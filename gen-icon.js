const zlib = require('zlib');
const fs = require('fs');

const W = 192, H = 192;

const sig = Buffer.from([137,80,78,71,13,10,26,10]);

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'ascii');
  data.copy(b, 8);
  b.writeUInt32BE(crc32(b, 4, 8 + data.length), 8 + data.length);
  return b;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2;

const row = Buffer.alloc(1 + W * 3);
row[0] = 0;
for (let x = 0; x < W; x++) {
  row[1 + x*3] = 0xd6;
  row[2 + x*3] = 0x29;
  row[3 + x*3] = 0x28;
}

const rows = [];
for (let y = 0; y < H; y++) rows.push(row);
const raw = Buffer.concat(rows);
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(__dirname + '/public/icon-192.png', png);
console.log('icon-192.png written (' + png.length + ' bytes)');
