import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const WIRE = "runtime/src/compiler.malw";

export interface CompilerBakeOptions {
	/** Fresh serialized compiler bytes supplied by any host. */
	bytes?: Uint8Array;
	/** Node-hosted in-process compiler callback, called only when the wire is stale. */
	bake?: () => Uint8Array;
	/** Exact prebuilt wire for a self-hosted eval-enabled build. */
	prebuiltPath?: string;
}

function isCompilerSource(name: string): boolean {
	return [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].some((suffix) =>
		name.endsWith(suffix),
	);
}

function newestSourceMtime(): number {
	let newest = 0;
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (isCompilerSource(entry.name))
				newest = Math.max(newest, statSync(full).mtimeMs);
		}
	};
	walk("src");
	return newest;
}

/**
 * Ensure the eval compiler wire is current without launching another language
 * host. Self-hosted callers pass bytes; Node callers pass an in-process bake.
 */
export function ensureCompilerWire(options: CompilerBakeOptions = {}): string {
	if (options.prebuiltPath !== undefined) {
		const source = path.resolve(options.prebuiltPath);
		const destination = path.resolve(WIRE);
		if (source !== destination) writeFileSync(destination, readFileSync(source));
		return WIRE;
	}
	if (options.bytes !== undefined) {
		writeFileSync(WIRE, options.bytes);
		return WIRE;
	}
	const exists = existsSync(WIRE);
	if (exists && process.env.MAL_BAKE === "skip") return WIRE;
	if (exists && statSync(WIRE).mtimeMs >= newestSourceMtime()) return WIRE;
	if (options.bake === undefined) {
		throw new Error(
			"eval-enabled build needs compiler wire bytes, a prebuilt wire path, or an in-process bake callback",
		);
	}
	writeFileSync(WIRE, options.bake());
	return WIRE;
}
