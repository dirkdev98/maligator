import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { resolveBuildConfig } from "../../build-config-values.ts";
import type { CompileEntrypointOptions } from "./compile-program-common.ts";

/** Bind the embedded compiler's host dependencies inside its module graph. */
export function embeddedCompilerOptions(sourceDirectory: string) {
	const require = createRequire(
		path.join(sourceDirectory, "compiler/frontend/parser.ts"),
	);
	const parser = require.resolve("meriyah");
	if (!parser.endsWith(".mjs"))
		throw new Error("The embedded parser requires Meriyah's ECMAScript module entry");
	const packageRoot = require.resolve
		.paths("meriyah")
		?.map((directory) => path.join(directory, "meriyah"))
		.find(existsSync);
	if (packageRoot === undefined)
		throw new Error("Could not locate the embedded parser package");
	const logicalParser = path.join(
		packageRoot,
		path.relative(realpathSync(packageRoot), parser),
	);
	const clone = path.join(sourceDirectory, "compiler/frontend/parser-clone.ts");
	const files = new Set([parser, logicalParser]);
	return {
		entryResultExport: "__compile",
		intrinsicGlobalReads: true,
		// The compiler runs spliced into a program that installs no globals for it, and
		// its image must not ask for installers the eval loader cannot resolve.
		buildConfig: resolveBuildConfig({}),
		transformSource: {
			files,
			transform: (source: string) =>
				`import { cloneParserData as structuredClone } from ${JSON.stringify(clone)};\n${source}`,
		},
	} satisfies Pick<
		CompileEntrypointOptions,
		"entryResultExport" | "intrinsicGlobalReads" | "transformSource" | "buildConfig"
	>;
}
