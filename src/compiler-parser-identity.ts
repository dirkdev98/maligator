import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** Dependency patches affect parser behavior without changing its pinned version. */
export function compilerParserIdentity(sourceDirectory: string) {
	const packagePath = path.join(sourceDirectory, "..", "package.json");
	const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
		dependencies?: { meriyah?: unknown };
	};
	const version = manifest.dependencies?.meriyah;
	if (typeof version !== "string" || version.length === 0)
		throw new Error(`compiler package does not pin meriyah: ${packagePath}`);
	const parser = createRequire(
		path.join(sourceDirectory, "compiler/frontend/parser.ts"),
	).resolve("meriyah");
	return { version, sourceDigest: hash("sha256", readFileSync(parser), "hex") };
}
