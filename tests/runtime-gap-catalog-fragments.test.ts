import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeGapCatalog } from "../scripts/runtime-gap-catalog.ts";
import { parseKernelOutput } from "../scripts/runtime-gap.ts";

function withCatalog(
	run: (file: string, fragment: (name: string, value: unknown) => void) => void,
) {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-catalog-fragments-"));
	const file = path.join(directory, "catalog.json");
	writeFileSync(
		file,
		JSON.stringify({ schema: 1, presets: { quick: [], survey: [] }, cases: [] }),
	);
	mkdirSync(path.join(directory, "catalog.d"));
	try {
		run(file, (name, value) =>
			writeFileSync(path.join(directory, "catalog.d", name), JSON.stringify(value)),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const descriptor = { ...loadRuntimeGapCatalog().cases[0]!, controls: [] };

describe("runtime-gap catalog fragments", () => {
	it("merges deterministic fragments under the same fixture and control validation", () => {
		withCatalog((file, fragment) => {
			fragment("b.json", { schema: 1, cases: [{ ...descriptor, id: "b" }] });
			fragment("a.json", {
				schema: 1,
				cases: [{ ...descriptor, id: "a", controls: ["b"] }],
			});
			const loaded = loadRuntimeGapCatalog(file);
			expect(loaded.cases.map((entry) => entry.id)).toEqual(["a", "b"]);
			expect(loaded.cases[0]!.fixturePath).toBe(
				path.resolve(path.dirname(file), descriptor.fixture),
			);
		});
	});

	it.each([
		["schema", { schema: 2, cases: [] }],
		["repeats", { schema: 1, cases: [descriptor, descriptor] }],
		["unknown control", { schema: 1, cases: [{ ...descriptor, controls: ["missing"] }] }],
		["escapes", { schema: 1, cases: [{ ...descriptor, fixture: "../outside.mjs" }] }],
	])("rejects invalid fragment: %s", (message, contents) => {
		withCatalog((file, fragment) => {
			fragment("bad.json", contents);
			expect(() => loadRuntimeGapCatalog(file)).toThrow(String(message));
		});
	});

	it("keeps capture, explicit-argument and escaping controls on identical arithmetic", () => {
		const catalog = loadRuntimeGapCatalog();
		const outputs = ["local", "explicit", "escaping"].map((kind) => {
			const descriptor = catalog.cases.find(
				(entry) => entry.id === `${kind}-capture-projection-helper`,
			)!;
			const output = parseKernelOutput(
				execFileSync(process.execPath, [descriptor.fixturePath, "1", "1"], {
					encoding: "utf8",
				}),
			);
			return { operations: output.operations, checksum: output.checksum };
		});
		expect(outputs[1]).toEqual(outputs[0]);
		expect(outputs[2]).toEqual(outputs[0]);
	});
});
