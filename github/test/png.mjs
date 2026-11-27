// tools/png.mjs, the PNG reader the screenshot comment compares images with: every color type and bit depth, each row
// filter, palettes and transparency; and, since the files come from pull requests, the hostile ones: a pixel bomb, an
// inflate bomb, truncated and malformed files, and interlaced ones (left to a byte comparison).
// Standalone suite: precommit runs it (tools/run-tests.mjs).
//
//   node test/png.mjs
import zlib from 'node:zlib';
import { decodePng, changedPixels } from '../tools/png.mjs';
import { encodePng, rgbaPng } from './fixtures/png.mjs';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}
function throws(name, run, re) {
	try {
		run();
		check(name, false, 'did not throw');
	} catch (e) {
		check(name, re.test(e.message), e.message);
	}
}
const pixel = (img, x, y) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// RGBA, 7x5, every row with another filter: the pixels come back as written
{
	const color = (x, y) => [x * 30, y * 50, (x * y * 7) & 255, 255 - x];
	const img = decodePng(rgbaPng(7, 5, color));
	let ok = img.width === 7 && img.height === 5;
	for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) ok &&= same(pixel(img, x, y), color(x, y));
	check('RGBA, all five row filters', ok);
}

// the other color types and depths, as RGBA
{
	const rgb = decodePng(encodePng({ width: 3, height: 2, type: 2, sample: (x, y) => [x, y, 9], filter: 'cycle' }));
	check('RGB is opaque', same(pixel(rgb, 2, 1), [2, 1, 9, 255]));
	const rgb16 = decodePng(encodePng({ width: 2, height: 2, type: 2, depth: 16, sample: () => [0x1234, 0xff00, 0x00ff] }));
	check('16-bit RGB keeps the high byte', same(pixel(rgb16, 1, 1), [0x12, 0xff, 0x00, 255]));
	const gray = decodePng(encodePng({ width: 9, height: 2, type: 0, depth: 1, sample: (x) => [x % 2] }));
	check('1-bit gray scales to 0 and 255', same(pixel(gray, 0, 0), [0, 0, 0, 255]) && same(pixel(gray, 1, 1), [255, 255, 255, 255]) && same(pixel(gray, 8, 0), [0, 0, 0, 255]));
	const gray4 = decodePng(encodePng({ width: 3, height: 1, type: 0, depth: 4, sample: (x) => [x * 5] }));
	check('4-bit gray scales by 17', same(pixel(gray4, 2, 0), [170, 170, 170, 255]));
	const grayAlpha = decodePng(encodePng({ width: 2, height: 1, type: 4, sample: (x) => [100, x * 200] }));
	check('gray with alpha', same(pixel(grayAlpha, 1, 0), [100, 100, 100, 200]));
	const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255];
	const indexed = decodePng(encodePng({ width: 5, height: 2, type: 3, depth: 2, palette, transparency: [255, 128], sample: (x) => [x % 3] }));
	check('a 2-bit palette, with transparency per entry', same(pixel(indexed, 0, 0), [255, 0, 0, 255]) && same(pixel(indexed, 1, 0), [0, 255, 0, 128]) && same(pixel(indexed, 2, 1), [0, 0, 255, 255]));
	const keyed = decodePng(encodePng({ width: 2, height: 1, type: 2, sample: (x) => [x, 0, 0], transparency: [0, 1, 0, 0, 0, 0] }));
	check('a truecolor color key makes that color transparent', same(pixel(keyed, 0, 0), [0, 0, 0, 255]) && same(pixel(keyed, 1, 0), [1, 0, 0, 0]));
	check('…and other chunks are skipped', decodePng(encodePng({ width: 1, height: 1, sample: () => [1, 2, 3, 4], chunks: [['tEXt', 'Comment\0hi']] })).width === 1);
}

// comparing
{
	const a = decodePng(rgbaPng(4, 4, () => [10, 20, 30, 255]));
	const b = decodePng(rgbaPng(4, 4, (x, y) => (x === 1 && y < 2 ? [10, 20, 31, 255] : [10, 20, 30, 255])));
	const rgb = decodePng(encodePng({ width: 4, height: 4, type: 2, sample: () => [10, 20, 30] }));
	check('changedPixels counts the pixels that differ', changedPixels(a, b) === 2 && changedPixels(a, a) === 0);
	check('…the same pixels in another color type are the same', changedPixels(a, rgb) === 0);
	check('…and every pixel when the sizes differ', changedPixels(a, decodePng(rgbaPng(5, 4, () => [0, 0, 0, 255]))) === 20);
}

// hostile and unsupported files
{
	const good = rgbaPng(2, 2, () => [1, 2, 3, 4]);
	throws('not a PNG', () => decodePng(Buffer.from('GIF89a....')), /not a PNG/);
	throws('a truncated file', () => decodePng(good.subarray(0, good.length - 20)), /truncated|IEND/);
	throws('a pixel bomb (huge dimensions, tiny file)', () => decodePng(encodePng({ width: 1, height: 1, sample: () => [0, 0, 0, 0] }).fill(0x7f, 16, 18), { maxPixels: 1000 }), /pixels/);
	// image data that inflates far past what a 2x2 image needs
	const bomb = Buffer.concat([good.subarray(0, 33), chunkOf('IDAT', zlib.deflateSync(Buffer.alloc(10 * 1024 * 1024))), chunkOf('IEND', Buffer.alloc(0))]);
	throws('an inflate bomb stops at the size the header allows', () => decodePng(bomb), /bad image data|wrong size/);
	throws('an interlaced image (compared byte for byte instead)', () => decodePng(encodePng({ width: 2, height: 2, sample: () => [0, 0, 0, 0], interlace: 1 })), /interlaced/);
	throws('a bad bit depth for its color type', () => decodePng(encodePng({ width: 2, height: 2, type: 2, depth: 4, sample: () => [0, 0, 0] })), /unsupported/);
	throws('a palette image without its palette', () => decodePng(encodePng({ width: 2, height: 1, type: 3, sample: () => [0] })), /without a palette/);
	throws('a palette index past the palette', () => decodePng(encodePng({ width: 2, height: 1, type: 3, palette: [1, 2, 3], sample: () => [4] })), /past the palette/);
	throws('an unknown row filter', () => decodePng(Buffer.concat([good.subarray(0, 33), chunkOf('IDAT', zlib.deflateSync(Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))), chunkOf('IEND', Buffer.alloc(0))])), /row filter/);
}

/** A chunk with a CRC of zeros: the reader doesn't check CRCs (a corrupt file just compares as different). */
function chunkOf(type, body) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, 'latin1');
	return Buffer.concat([head, body, Buffer.alloc(4)]);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
