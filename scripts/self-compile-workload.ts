import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { resolveBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";

export const SELF_COMPILE_CONFIG = resolveBuildConfig({
	engine: { eval: false, realms: false, regexp: true, intl: { enabled: false } },
	surface: { webPlatform: false, node: true, maligator: true },
});

export function digestSelfCompileOutput(
	directory: string,
	normalizePaths: ReadonlyArray<string> = [],
): string {
	const digest = createHash("sha256");
	for (const name of readdirSync(directory).sort()) {
		if (name === "self-compile.malw") continue;
		digest.update(name);
		let source = readFileSync(path.join(directory, name), "utf8");
		for (const normalizePath of normalizePaths) {
			if (normalizePath.length > 0) {
				source = source.split(normalizePath).join("<self-compile-source>");
			}
		}
		digest.update(source);
	}
	return digest.digest("hex");
}

/** Static counts of root publication and runtime work spelled in emitted C. */
export interface EmittedCSummary {
	readonly codeUnits: number;
	readonly rootPublicationStores: number;
	readonly rootClears: number;
	readonly rootMasks: number;
	readonly wideRootMasks: number;
	readonly undefinedRegisterStores: number;
	readonly throwChecks: number;
	readonly runtimeCallSites: number;
}

const EMITTED_C_PATTERNS = {
	rootPublicationStores: /__gc_slots\[\d+\] = r\d+;/g,
	rootClears: /__gc_slots\[\d+\] = MAL_VALUE_UNDEFINED;/g,
	rootMasks: /\bMAL_ROOT_MASK(?:_WIDE)?\(/g,
	wideRootMasks: /\bMAL_ROOT_MASK_WIDE\(/g,
	// Entry zeroing and CREATE_UNDEFINED share this spelling.
	undefinedRegisterStores: /^ {4}r\d+ = MAL_VALUE_UNDEFINED;$/gm,
	// Older emitters spell the completion test inline.
	throwChecks: /MAL_THREW\(\)|vm->completion\.kind == MAL_COMPLETION_THROW/g,
	runtimeCallSites: /\bmal_[a-z0-9_]+\(/g,
} as const;

export function summarizeEmittedC(directory: string): EmittedCSummary {
	const counts = Object.fromEntries(
		Object.keys(EMITTED_C_PATTERNS).map((name) => [name, 0]),
	) as Record<keyof typeof EMITTED_C_PATTERNS, number>;
	let codeUnits = 0;
	for (const name of readdirSync(directory).sort()) {
		if (!name.endsWith(".c")) continue;
		const source = readFileSync(path.join(directory, name), "utf8");
		codeUnits += source.length;
		for (const [key, pattern] of Object.entries(EMITTED_C_PATTERNS))
			counts[key as keyof typeof EMITTED_C_PATTERNS] +=
				source.match(pattern)?.length ?? 0;
	}
	return { codeUnits, ...counts };
}

function copyStrippedTree(source: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		if (entry.isDirectory()) {
			copyStrippedTree(from, to);
		} else if (/\.(?:ts|mts|cts)$/.test(entry.name)) {
			writeFileSync(to, stripCompactTypes(readFileSync(from, "utf8"), from));
		} else if (entry.isFile()) {
			copyFileSync(from, to);
		}
	}
}

export function prepareSelfCompileSource(
	root: string,
	sourceRoot = path.resolve("."),
): string {
	mkdirSync(root, { recursive: true });
	writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
	copyStrippedTree(path.join(sourceRoot, "src"), path.join(root, "src"));
	mkdirSync(path.join(root, "bench"), { recursive: true });
	const fixture = path.join(sourceRoot, "bench/self-compile.mts");
	writeFileSync(
		path.join(root, "bench/self-compile.mts"),
		stripCompactTypes(readFileSync(fixture, "utf8"), fixture),
	);
	symlinkSync(
		path.join(sourceRoot, "node_modules"),
		path.join(root, "node_modules"),
		"dir",
	);
	return path.join(root, "bench/self-compile.mts");
}
