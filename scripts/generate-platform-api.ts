import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";
import type { FormatConfig } from "oxfmt";
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";
import { generatePlatformDeclarations } from "../src/platform/generate.ts";

export async function generatePlatformApi(check = false): Promise<void> {
	const formatOptions = JSON.parse(readFileSync(".oxfmtrc.json", "utf8")) as FormatConfig;
	const outputs: Array<readonly [string, string]> = [
		[
			path.resolve("src/platform-api.d.ts"),
			[
				"// Generated from src/platform/catalog.ts; edit the catalog and regenerate.",
				...PLATFORM_MODULES.map(
					(module) => `import ${JSON.stringify(`./${module.declarationFile}`)};`,
				),
				"",
			].join("\n"),
		],
		...PLATFORM_MODULES.map((module): readonly [string, string] => [
			path.resolve("src", module.declarationFile),
			generatePlatformDeclarations(module),
		]),
	];
	for (const [file, contents] of outputs) {
		const formatted = await format(file, contents, formatOptions);
		if (formatted.errors.length > 0)
			throw new Error(`Cannot format generated platform API: ${file}`);
		if (check) {
			if (readFileSync(file, "utf8") !== formatted.code)
				throw new Error(`Generated platform API is stale: ${file}`);
		} else writeFileSync(file, formatted.code);
	}
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await generatePlatformApi(process.argv.includes("--check"));
}
