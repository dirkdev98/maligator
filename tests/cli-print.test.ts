import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { cleanTestEnvironment } from "../scripts/test-environment.ts";

it.each([
	{
		location: "entry.mts:2:23",
		files: [["entry.mts", "// Fixture\nconst label: string = ;\n"]] as const,
		line: "const label: string = ;",
		caret: 22,
		message: /Unexpected token/,
	},
	{
		location: "invalid.json:2:12",
		files: [
			["entry.mts", 'import value from "./invalid.json" with { type: "json" };\n'],
			["invalid.json", '{\n  "label": ,\n}\n'],
		] as const,
		line: '  "label": ,',
		caret: 11,
		message: /JSON/,
	},
	{
		location: "entry.mts:2:8",
		files: [["entry.mts", '// Fixture\nimport "./absent.mjs";\n']] as const,
		line: 'import "./absent.mjs";',
		caret: 7,
		message: /absent\.mjs/,
	},
])(
	"locates the build diagnostic at $location",
	({ location, files, line, caret, message }) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-cli-diagnostic-"));
		try {
			for (const [file, source] of files) {
				writeFileSync(path.join(directory, file), source);
			}
			const result = spawnSync(
				process.execPath,
				[path.resolve("src/index.ts"), "build", "entry.mts", "--serialize", "entry.malw"],
				{
					cwd: directory,
					env: cleanTestEnvironment(),
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(1);
			const lines = result.stderr.split("\n");
			const diagnostic = lines.findIndex((line) => line.includes(location));
			expect(diagnostic, result.stderr).toBeGreaterThanOrEqual(0);
			expect(lines[diagnostic]).toMatch(message);
			expect(lines[diagnostic + 1]?.trim()).toBe(line.trim());
			const frameIndent = lines[diagnostic + 1]!.indexOf(line);
			expect(lines[diagnostic + 2]?.indexOf("^")).toBe(frameIndent + caret);
			expect(lines.slice(diagnostic, diagnostic + 3).join("\n")).not.toContain("\u001b");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

it("suggests public Maligator modules for an unknown module", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-cli-module-suggestions-"));
	try {
		writeFileSync(path.join(directory, "entry.mjs"), 'import "maligator:example";\n');
		const result = spawnSync(
			process.execPath,
			[path.resolve("src/index.ts"), "build", "entry.mjs", "--serialize", "entry.malw"],
			{ cwd: directory, env: cleanTestEnvironment(), encoding: "utf8", timeout: 30_000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("maligator:http");
		expect(result.stderr).not.toContain("maligator:internal/");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("prints generated C without building or publishing an executable artifact", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-cli-print-"));
	try {
		writeFileSync(path.join(directory, "main.mts"), "console.log(42);\n");
		writeFileSync(
			path.join(directory, "maligator.build.mts"),
			`export default {
	entry: "main.mts",
	engine: { eval: false, regexp: false, intl: { enabled: false } },

};\n`,
		);
		const artifact = path.join(directory, "artifact");
		const result = spawnSync(
			process.execPath,
			[
				path.resolve("src/index.ts"),
				"build",
				"--config",
				"maligator.build.mts",
				"--production",
				"--print",
				"--artifact",
				artifact,
			],
			{ cwd: directory, env: cleanTestEnvironment(), encoding: "utf8", timeout: 30_000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.length).toBeGreaterThan(0);
		expect(existsSync(artifact)).toBe(false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
