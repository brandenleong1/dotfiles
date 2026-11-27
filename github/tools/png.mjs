// A small PNG reader for tools/screenshot-comment.mjs: it turns a PNG into RGBA pixels, so two screenshots can be
// compared by what they show rather than by their bytes (two encoders, or two runs of one, can write the same pixels
// differently). The files come from a pull request's code, so this is written for hostile input: it never inflates
// more than the image header says the pixels need, refuses images over a pixel budget, and throws on anything it
// doesn't understand (the caller then falls back to comparing bytes). No dependencies: node:zlib only.
//
//   decodePng(buffer, { maxPixels }) -> { width, height, rgba }   (throws on a bad or unsupported file)
//   changedPixels(a, b) -> how many pixels differ (all of them when the sizes differ)
import zlib from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };   // color type: samples per pixel
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** A PNG's pixels as 8-bit RGBA. Interlaced images, and anything malformed, throw. */
export function decodePng(buffer, { maxPixels = 4096 * 4096 } = {}) {
	const { header, palette, transparency, data } = readChunks(buffer);
	const { width, height, depth, type } = header;
	if (width * height > maxPixels) throw new Error(`${width}x${height} is more than ${maxPixels} pixels`);
	const bitsPerPixel = CHANNELS[type] * depth;
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	const expected = (stride + 1) * height;
	let raw;
	try {
		raw = zlib.inflateSync(data, { maxOutputLength: expected });
	} catch (e) {
		throw new Error(`bad image data (${e.code || e.message})`);
	}
	if (raw.length !== expected) throw new Error('image data of the wrong size');
	const rows = unfilter(raw, { stride, height, bytesPerPixel: Math.max(1, bitsPerPixel >> 3) });
	return { width, height, rgba: toRgba(rows, { width, height, stride, depth, type, palette, transparency }) };
}

/** How many pixels differ between two decoded images; every pixel of the larger one when their sizes differ. */
export function changedPixels(a, b) {
	if (a.width !== b.width || a.height !== b.height) return Math.max(a.width * a.height, b.width * b.height);
	let count = 0;
	for (let i = 0; i < a.rgba.length; i += 4) {
		if (a.rgba[i] !== b.rgba[i] || a.rgba[i + 1] !== b.rgba[i + 1] || a.rgba[i + 2] !== b.rgba[i + 2] || a.rgba[i + 3] !== b.rgba[i + 3]) count++;
	}
	return count;
}

/** The header, palette, transparency and the joined image data of a PNG's chunks. */
function readChunks(buffer) {
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
	let header = null, palette = null, transparency = null;
	const data = [];
	for (let pos = 8; ;) {
		if (pos + 12 > buffer.length) throw new Error('no IEND chunk');
		const length = buffer.readUInt32BE(pos);
		const type = buffer.toString('latin1', pos + 4, pos + 8);
		const start = pos + 8, end = start + length;
		if (end + 4 > buffer.length) throw new Error(`truncated ${type} chunk`);
		const body = buffer.subarray(start, end);
		if (type === 'IHDR') header = readHeader(body);
		else if (!header) throw new Error('IHDR is not the first chunk');
		else if (type === 'PLTE') palette = body;
		else if (type === 'tRNS') transparency = body;
		else if (type === 'IDAT') data.push(body);
		else if (type === 'IEND') break;
		pos = end + 4;   // the chunk's CRC is skipped: a corrupt file only compares as different
	}
	if (!header || !data.length) throw new Error('no image data');
	if (header.type === 3 && !palette) throw new Error('a palette image without a palette');
	return { header, palette, transparency, data: Buffer.concat(data) };
}

function readHeader(body) {
	if (body.length !== 13) throw new Error('bad IHDR');
	const header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], type: body[9] };
	if (!header.width || !header.height) throw new Error('an empty image');
	if (!(DEPTHS[header.type] || []).includes(header.depth)) throw new Error(`unsupported color type ${header.type} at depth ${header.depth}`);
	if (body[10] !== 0 || body[11] !== 0) throw new Error('unknown compression or filter method');
	if (body[12] !== 0) throw new Error('interlaced');
	return header;
}

/** Undo the per-row filters (None, Sub, Up, Average, Paeth): the rows' bytes, without their filter bytes. */
function unfilter(raw, { stride, height, bytesPerPixel }) {
	const out = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= bytesPerPixel ? out[row + x - bytesPerPixel] : 0;
			const up = y > 0 ? out[prev + x] : 0;
			const upLeft = y > 0 && x >= bytesPerPixel ? out[prev + x - bytesPerPixel] : 0;
			let predicted;
			if (filter === 0) predicted = 0;
			else if (filter === 1) predicted = left;
			else if (filter === 2) predicted = up;
			else if (filter === 3) predicted = (left + up) >> 1;
			else if (filter === 4) predicted = paeth(left, up, upLeft);
			else throw new Error(`unknown row filter ${filter}`);
			out[row + x] = (raw[src + x] + predicted) & 0xff;
		}
	}
	return out;
}

function paeth(a, b, c) {
	const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

/** The unfiltered rows as 8-bit RGBA, with a palette's or a color key's transparency applied. */
function toRgba(rows, { width, height, stride, depth, type, palette, transparency }) {
	const channels = CHANNELS[type];
	const max = (1 << depth) - 1;
	const sample = (row, i) => {   // the i-th sample of a row, at the image's own depth
		if (depth === 16) return rows.readUInt16BE(row + i * 2);
		if (depth === 8) return rows[row + i];
		const bit = i * depth;
		return (rows[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
	};
	const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
	const key = transparency && (type === 0 || type === 2) ? colorKey(transparency, type) : null;
	const out = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		const row = y * stride;
		for (let x = 0; x < width; x++) {
			const s = (c) => sample(row, x * channels + c);
			const o = (y * width + x) * 4;
			if (type === 3) {
				const index = s(0);
				if (index * 3 + 2 >= palette.length) throw new Error('a palette index past the palette');
				palette.copy(out, o, index * 3, index * 3 + 3);
				out[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
				continue;
			}
			const gray = type === 0 || type === 4;
			const values = gray ? [s(0), s(0), s(0)] : [s(0), s(1), s(2)];
			out[o] = to8(values[0]);
			out[o + 1] = to8(values[1]);
			out[o + 2] = to8(values[2]);
			const alpha = type === 4 ? s(1) : type === 6 ? s(3) : null;
			const keyed = key && (gray ? values[0] === key[0] : values.every((v, i) => v === key[i]));
			out[o + 3] = alpha !== null ? to8(alpha) : keyed ? 0 : 255;
		}
	}
	return out;
}

/** The one color a gray or truecolor image's tRNS chunk makes transparent, as samples at the image's depth. */
function colorKey(transparency, type) {
	const count = type === 0 ? 1 : 3;
	if (transparency.length < count * 2) throw new Error('bad tRNS');
	return Array.from({ length: count }, (_, i) => transparency.readUInt16BE(i * 2));
}
