// A small PNG writer for the tests (test/png.mjs, test/screenshot-comment.mjs): tiny images of any color type and bit
// depth tools/png.mjs reads, with each row filtered as asked, so the reader's unfiltering is tested too.
//
//   encodePng({ width, height, type = 6, depth = 8, sample(x, y) -> [samples], filter = 0 | 'cycle',
//               palette?, transparency?, interlace?, chunks? }) -> Buffer
import zlib from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

export function encodePng({ width, height, type = 6, depth = 8, sample, filter = 0, palette = null, transparency = null, interlace = 0, chunks = [] }) {
	const channels = CHANNELS[type];
	const bitsPerPixel = channels * depth;
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
	const rows = [];
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(stride);
		for (let x = 0; x < width; x++) {
			sample(x, y).forEach((v, c) => writeSample(row, x * channels + c, v, depth));
		}
		rows.push(row);
	}
	const filtered = rows.map((row, y) => {
		const kind = filter === 'cycle' ? y % 5 : filter;
		return Buffer.concat([Buffer.from([kind]), filterRow(row, y ? rows[y - 1] : Buffer.alloc(stride), kind, bytesPerPixel)]);
	});
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = depth;
	header[9] = type;
	header[12] = interlace;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
		...(transparency ? [chunk('tRNS', Buffer.from(transparency))] : []),
		...chunks.map(([name, body]) => chunk(name, Buffer.from(body))),
		chunk('IDAT', zlib.deflateSync(Buffer.concat(filtered))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** An 8-bit RGBA image from `rgba(x, y) -> [r, g, b, a]`, rows filtered in turn with each of the five filters. */
export function rgbaPng(width, height, rgba) {
	return encodePng({ width, height, type: 6, depth: 8, sample: rgba, filter: 'cycle' });
}

function writeSample(row, i, value, depth) {
	if (depth === 16) return row.writeUInt16BE(value, i * 2);
	if (depth === 8) {
		row[i] = value;
		return;
	}
	const bit = i * depth;
	row[bit >> 3] |= value << (8 - depth - (bit & 7));
}

function filterRow(row, prev, kind, bpp) {
	const out = Buffer.alloc(row.length);
	for (let x = 0; x < row.length; x++) {
		const left = x >= bpp ? row[x - bpp] : 0, up = prev[x], upLeft = x >= bpp ? prev[x - bpp] : 0;
		const predicted = kind === 0 ? 0 : kind === 1 ? left : kind === 2 ? up : kind === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
		out[x] = (row[x] - predicted) & 0xff;
	}
	return out;
}

function paeth(a, b, c) {
	const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

function chunk(type, body) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, 'latin1');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
	return Buffer.concat([head, body, crc]);
}

function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
