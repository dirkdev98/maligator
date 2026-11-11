import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary } from "../../src/test-harness.ts";
import { writePrimordialInventoryDriver } from "../helpers/primordial-inventory.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-bigint-inventory-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
it("exports complete signed BigInt decimal values through the inventory driver", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		name: "primordial-bigint-inventory",
		mainFile: writePrimordialInventoryDriver(outDir),
		outDir,
		config: resolveBuildConfig({
			engine: {
				eval: false,
				realms: false,
				regexp: false,
				temporal: false,
				intl: { enabled: false },
			},
			surface: { node: false, webPlatform: false, maligator: false },
		}),
	});
	const values = execFileSync(binary, ["--check-bigints"], {
		encoding: "utf8",
		timeout: 15000,
	})
		.trim()
		.split("\n")
		.map((line) => (JSON.parse(line) as { bigint: string }).bigint);
	const positive = (1n << 512n) + 123456789n;
	expect(values).toEqual([positive.toString(), "0", (-positive).toString()]);
});
