import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const BUILD_CONFIG_NAME = "maligator.build.ts";

const ENTRY_CANDIDATES = ["src/index.ts", "src/main.ts", "index.ts", "main.ts"];

export class InitError extends Error {
	constructor(message: string) {
		super(message);
		Object.defineProperty(this, "name", { value: "InitError", configurable: true });
	}
}

export function detectInitialEntry(cwd: string): string {
	return (
		ENTRY_CANDIDATES.find((candidate) => existsSync(path.join(cwd, candidate))) ??
		ENTRY_CANDIDATES[0]!
	);
}

export function initProject(cwd: string = process.cwd()): string {
	const configPath = path.join(cwd, BUILD_CONFIG_NAME);
	if (existsSync(configPath)) {
		throw new InitError(`build config already exists: ${configPath}`);
	}

	const entry = detectInitialEntry(cwd);
	writeFileSync(
		configPath,
		`import { defineBuild } from "@maligator/cli";\n\nexport default defineBuild({\n\tentry: ${JSON.stringify(entry)},\n});\n`,
	);
	return configPath;
}
