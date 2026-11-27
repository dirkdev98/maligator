import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "../src/index.ts";

const examples = path.join(import.meta.dirname, "examples");
const oxlint = path.join(
	path.dirname(createRequire(import.meta.url).resolve("oxlint/package.json")),
	"bin/oxlint",
);
const scratch = mkdtempSync(path.join(tmpdir(), "maligator-lint-examples-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface OxlintReport {
	diagnostics: Array<{ code: string; filename: string }>;
}

/** Lints one rule's examples through the CLI with only that rule enabled. */
function lintExamples(rule: string): OxlintReport {
	const config = path.join(scratch, `${rule}.json`);
	writeFileSync(
		config,
		JSON.stringify({
			jsPlugins: [path.join(import.meta.dirname, "../src/index.ts")],
			categories: { correctness: "off" },
			rules: { [`maligator/${rule}`]: "error" },
		}),
	);
	const result = spawnSync(
		process.execPath,
		[oxlint, "-c", config, "--format", "json", path.join(examples, rule)],
		{ cwd: examples, encoding: "utf8" },
	);
	expect(result.stderr).toBe("");
	return JSON.parse(result.stdout) as OxlintReport;
}

describe("documented examples", () => {
	for (const rule of Object.keys(plugin.rules)) {
		it(`flag every bad ${rule} example and none of the good ones`, () => {
			const files = readdirSync(path.join(examples, rule));
			const flagged = new Set(
				lintExamples(rule)
					.diagnostics.filter(({ code }) => code === `maligator(${rule})`)
					.map(({ filename }) => path.basename(filename)),
			);
			expect([...flagged].sort()).toEqual(
				files.filter((file) => file.includes(".bad.")).sort(),
			);
			expect(files.some((file) => file.includes(".good."))).toBe(true);
		});
	}
});
