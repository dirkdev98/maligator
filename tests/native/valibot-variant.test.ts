import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-valibot-variant-"));
const fixture = "tests/local/valibot-variant.mjs";

describe("Valibot variant schemas", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({ fixture, name: "valibot-variant", outDir });
	});

	it.each([
		["normal", {}],
		["GC stress", STRESS_ENV],
	])("dispatches the matching object schema under %s execution", (_name, environment) => {
		const result = spawnSync(binary, [], {
			env: { ...process.env, ...environment },
			encoding: "utf-8",
			timeout: 60_000,
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "valibot-variant");
	});
});
