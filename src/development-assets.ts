import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { IncludedAsset } from "./assets.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { frontendDigest } from "./frontend-cache.ts";

const DEVELOPMENT_ASSET_MANIFEST_VERSION = 1;

class BinaryWriter {
	readonly #bytes: Array<number> = [];
	readonly #encoder = new TextEncoder();

	u8(value: number): void {
		this.#bytes.push(value & 0xff);
	}

	u32(value: number): void {
		for (let offset = 0; offset < 32; offset += 8) this.u8(value >>> offset);
	}

	u64(value: number): void {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`development asset size is out of range: ${value}`);
		}
		this.u32(value >>> 0);
		this.u32(Math.floor(value / 0x1_0000_0000));
	}

	string(value: string): void {
		const bytes = this.#encoder.encode(value);
		this.u32(bytes.length);
		for (const byte of bytes) this.u8(byte);
	}

	finish(): Uint8Array {
		return Uint8Array.from(this.#bytes);
	}
}

/** Serialize external development assets without changing the portable VM wire. */
export function serializeDevelopmentAssets(assets: Array<IncludedAsset>): Uint8Array {
	const writer = new BinaryWriter();
	for (const byte of new TextEncoder().encode("MALA")) writer.u8(byte);
	writer.u32(DEVELOPMENT_ASSET_MANIFEST_VERSION);
	writer.u32(assets.length);
	for (const asset of assets) {
		writer.string(asset.name);
		writer.string(asset.hash);
		writer.string(asset.version);
		writer.u8(asset.type === "directory" ? 1 : 0);
		writer.u32(asset.files.length);
		for (const file of asset.files) {
			writer.string(file.path);
			writer.string(file.sourcePath);
			writer.u64(file.size);
		}
	}
	return writer.finish();
}

/** Publish one content-addressed external-asset manifest for run/dev. */
export function cacheDevelopmentAssets(
	assets: Array<IncludedAsset>,
	cacheDirectory = maligatorCacheDirectory(),
): string | undefined {
	if (assets.length === 0) return undefined;
	const bytes = serializeDevelopmentAssets(assets);
	const digest = frontendDigest(bytes);
	const directory = path.resolve(cacheDirectory, "development-assets");
	const file = path.join(directory, `${digest}.mala`);
	try {
		if (frontendDigest(new Uint8Array(readFileSync(file))) === digest) return file;
	} catch {
		// Publish below.
	}
	mkdirSync(directory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
	try {
		const temporaryPath = path.join(temporaryDirectory, "assets.mala");
		writeFileSync(temporaryPath, bytes);
		renameSync(temporaryPath, file);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	if (frontendDigest(new Uint8Array(readFileSync(file))) !== digest) {
		throw new Error(`development asset manifest publication failed: ${file}`);
	}
	return file;
}
