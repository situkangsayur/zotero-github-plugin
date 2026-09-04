#!/usr/bin/env node
/* Build the installable .xpi.
 *
 * A Zotero plugin is a ZIP with a manifest at the root, so this writes one
 * directly -- stored, not deflated, which Zotero accepts and which keeps the
 * build free of dependencies (no npm install needed to produce a release).
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, 'build');

// Everything the plugin needs at runtime, and nothing else
const INCLUDE = [
	'manifest.json',
	'bootstrap.js',
	'prefs.js',
	'README.md',
	'LICENSE',
	'src',
	'content',
];


async function collect(entry) {
	let absolute = join(ROOT, entry);
	let info;
	try {
		info = await stat(absolute);
	}
	catch (e) {
		if (e.code === 'ENOENT') {
			return [];
		}
		throw e;
	}
	if (info.isFile()) {
		return [entry];
	}
	let files = [];
	for (let child of await readdir(absolute, { withFileTypes: true })) {
		if (child.name.startsWith('.')) {
			continue;
		}
		files.push(...await collect(join(entry, child.name)));
	}
	return files;
}


// -- Minimal ZIP writer (store only) --------------------------------------

const CRC_TABLE = (() => {
	let table = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c;
	}
	return table;
})();


function crc32(buffer) {
	let crc = -1;
	for (let i = 0; i < buffer.length; i++) {
		crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
	}
	return (crc ^ -1) >>> 0;
}


function dosDateTime(date) {
	// MS-DOS packs the timestamp into two 16-bit fields, seconds in units of two
	let time = ((date.getHours() & 0x1F) << 11)
		| ((date.getMinutes() & 0x3F) << 5)
		| ((Math.floor(date.getSeconds() / 2)) & 0x1F);
	let day = (((date.getFullYear() - 1980) & 0x7F) << 9)
		| (((date.getMonth() + 1) & 0x0F) << 5)
		| (date.getDate() & 0x1F);
	return { time, day };
}


function buildZip(entries) {
	let chunks = [];
	let central = [];
	let offset = 0;
	let { time, day } = dosDateTime(new Date());

	for (let { name, data } of entries) {
		let nameBytes = Buffer.from(name, 'utf8');
		let crc = crc32(data);

		let localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034B50, 0);
		localHeader.writeUInt16LE(20, 4); // version needed
		localHeader.writeUInt16LE(0, 6); // flags
		localHeader.writeUInt16LE(0, 8); // method: stored
		localHeader.writeUInt16LE(time, 10);
		localHeader.writeUInt16LE(day, 12);
		localHeader.writeUInt32LE(crc, 14);
		localHeader.writeUInt32LE(data.length, 18);
		localHeader.writeUInt32LE(data.length, 22);
		localHeader.writeUInt16LE(nameBytes.length, 26);
		localHeader.writeUInt16LE(0, 28);

		chunks.push(localHeader, nameBytes, data);

		let centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014B50, 0);
		centralHeader.writeUInt16LE(20, 4); // version made by
		centralHeader.writeUInt16LE(20, 6); // version needed
		centralHeader.writeUInt16LE(0, 8);
		centralHeader.writeUInt16LE(0, 10);
		centralHeader.writeUInt16LE(time, 12);
		centralHeader.writeUInt16LE(day, 14);
		centralHeader.writeUInt32LE(crc, 16);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(nameBytes.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(0, 38);
		centralHeader.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([centralHeader, nameBytes]));

		offset += localHeader.length + nameBytes.length + data.length;
	}

	let centralBuffer = Buffer.concat(central);
	let end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054B50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuffer.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...chunks, centralBuffer, end]);
}


// -- Build ----------------------------------------------------------------

async function main() {
	let manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
	let version = manifest.version;

	let paths = [];
	for (let entry of INCLUDE) {
		paths.push(...await collect(entry));
	}
	paths.sort();

	let entries = [];
	for (let path of paths) {
		entries.push({
			// ZIP paths always use forward slashes
			name: path.split(sep).join('/'),
			data: await readFile(join(ROOT, path)),
		});
	}

	let zip = buildZip(entries);
	await mkdir(BUILD_DIR, { recursive: true });
	let outPath = join(BUILD_DIR, `zotero-github-sync-${version}.xpi`);
	await writeFile(outPath, zip);

	let sha = createHash('sha256').update(zip).digest('hex');
	console.log(`Built ${relative(ROOT, outPath)}`);
	console.log(`  ${entries.length} files, ${(zip.length / 1024).toFixed(1)} KB`);
	console.log(`  sha256:${sha}`);
}


main().catch((e) => {
	console.error(e);
	process.exit(1);
});
