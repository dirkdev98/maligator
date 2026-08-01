import { hash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

interface TarEntry {
	name: string;
	mode: number;
	bytes: Uint8Array;
}

function writeOctal(
	header: Uint8Array,
	offset: number,
	length: number,
	value: number,
): void {
	const encoded = value.toString(8).padStart(length - 1, "0");
	if (encoded.length >= length) throw new Error(`tar value is too large: ${value}`);
	header.set(Buffer.from(`${encoded}\0`), offset);
}

function writeString(
	header: Uint8Array,
	offset: number,
	length: number,
	value: string,
): void {
	const encoded = Buffer.from(value);
	if (encoded.length > length) throw new Error(`tar path is too long: ${value}`);
	header.set(encoded, offset);
}

function tarHeader(entry: TarEntry): Uint8Array {
	const header = Buffer.alloc(512);
	writeString(header, 0, 100, entry.name);
	writeOctal(header, 100, 8, entry.mode);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, entry.bytes.length);
	writeOctal(header, 136, 12, 0);
	header.fill(0x20, 148, 156);
	header[156] = 0x30;
	writeString(header, 257, 6, "ustar");
	writeString(header, 263, 2, "00");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	const encodedChecksum = checksum.toString(8).padStart(6, "0");
	header.set(Buffer.from(`${encodedChecksum}\0 `), 148);
	return header;
}

export function deterministicTar(entries: Array<TarEntry>): Uint8Array {
	const chunks: Array<Uint8Array> = [];
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		chunks.push(tarHeader(entry), entry.bytes);
		const padding = (512 - (entry.bytes.length % 512)) % 512;
		if (padding > 0) chunks.push(Buffer.alloc(padding));
	}
	chunks.push(Buffer.alloc(1024));
	return Buffer.concat(chunks);
}

export interface ReleaseArchiveResult {
	archivePath: string;
	checksumPath: string;
	sha256: string;
}

export function createReleaseArchive(
	artifactDirectory: string,
	archivePath: string,
	rootName: string,
): ReleaseArchiveResult {
	const manifestBytes = readFileSync(path.join(artifactDirectory, "artifact.json"));
	const manifest = JSON.parse(manifestBytes.toString()) as {
		files: Array<{ path: string }>;
	};
	const entries: Array<TarEntry> = [
		{
			name: `${rootName}/SHA256SUMS`,
			mode: 0o644,
			bytes: readFileSync(path.join(artifactDirectory, "SHA256SUMS")),
		},
		{
			name: `${rootName}/artifact.json`,
			mode: 0o644,
			bytes: manifestBytes,
		},
	];
	for (const file of manifest.files) {
		entries.push({
			name: `${rootName}/${file.path}`,
			mode: file.path.startsWith("bin/") ? 0o755 : 0o644,
			bytes: readFileSync(path.join(artifactDirectory, file.path)),
		});
	}
	const compressed = gzipSync(deterministicTar(entries), { level: 9 });
	writeFileSync(archivePath, compressed);
	const sha256 = hash("sha256", compressed, "hex");
	const checksumPath = `${archivePath}.sha256`;
	writeFileSync(checksumPath, `${sha256}  ${path.basename(archivePath)}\n`);
	return { archivePath, checksumPath, sha256 };
}
