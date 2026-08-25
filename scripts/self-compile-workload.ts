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

export function prepareSelfCompileSource(root: string): string {
	mkdirSync(root, { recursive: true });
	writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
	copyStrippedTree(path.resolve("src"), path.join(root, "src"));
	mkdirSync(path.join(root, "bench"), { recursive: true });
	const fixture = path.resolve("bench/self-compile.mts");
	writeFileSync(
		path.join(root, "bench/self-compile.mts"),
		stripCompactTypes(readFileSync(fixture, "utf8"), fixture),
	);
	symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
	return path.join(root, "bench/self-compile.mts");
}
