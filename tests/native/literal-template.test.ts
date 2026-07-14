import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-literal-template-"));

describe("static data literal templates", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		const fixture = path.join(outDir, "literal-template-generated.js");
		const largeTemplate = `const largeTemplate = [${Array.from(
			{ length: 1100 },
			(_, i) => `{ value: ${i} }`,
		).join(
			",",
		)}];\nok("large rooted graph", largeTemplate.length === 1100 && largeTemplate[1099].value === 1099);`;
		writeFileSync(
			fixture,
			readFileSync("tests/local/literal-template.js", "utf8").replace(
				"/* GENERATED_LARGE_TEMPLATE */",
				largeTemplate,
			),
		);
		compiled = buildNativeBinary({
			fixture,
			name: "literal-template",
			outDir,
			skipRuntimeBuild: true,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "literal-template-ni",
			compiled: false,
			outDir,
			skipRuntimeBuild: true,
		});
	});

	it("passes compiled", () => {
		assertPassLine(runToStdout(compiled), "literal-template");
	});

	it("passes compiled under GC stress", () => {
		assertPassLine(runToStdout(compiled, { env: STRESS_ENV }), "literal-template");
	});

	it("passes interpreted", () => {
		assertPassLine(runToStdout(interpreted), "literal-template");
	});
});
