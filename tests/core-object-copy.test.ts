import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(body: string, prefix = "") {
	return inspectStaticValueFunction(
		`${prefix} function target(source, extra) { ${body} } globalThis.target = target;`,
		"target",
	);
}

describe("initial object spread", () => {
	it("represents a dynamic initial spread as one allocating copy", () => {
		const out = inspect("return { ...source, extra };");
		expect(
			out.core
				.filter((instruction) => instruction.opcode === "copyDataProperties")
				.map((instruction) => instruction.attributes),
		).toEqual([{ copyMode: "spread", slotReserve: 1 }]);
		expect(
			out.core.some((instruction) => instruction.opcode === "mergeDataProperties"),
		).toBe(false);
	});

	it("keeps constant spreads folded into shaped literals", () => {
		const out = inspect(
			'const constant = { id: 7, name: "record", score: 3 }; return { ...constant, extra };',
		);
		expect(
			out.core.some((instruction) => instruction.opcode === "copyDataProperties"),
		).toBe(false);
		expect(
			out.core.some((instruction) => instruction.opcode === "createObjectShaped"),
		).toBe(true);
	});

	it("folds a module constant after inlining with a dynamic trailing field", () => {
		const scratch = mkdtempSync(join(tmpdir(), "mal-object-copy-"));
		try {
			const entry = join(scratch, "entry.mjs");
			writeFileSync(
				entry,
				`const constant = { id: 7, name: "record", score: 3 };
			function copy(extra) { return { ...constant, extra }; }
			console.log(copy(Date.now()));`,
			);
			const image = compileEntrypoint(entry, {
				buildConfig: resolveBuildConfig({ surface: { node: true } }),
				optimization: "full",
			});
			const operations = image.runtime.functions.flatMap((fn) => fn.instructions);
			expect(
				operations.some((instruction) => instruction.opcode === "CREATE_OBJECT_SHAPED"),
			).toBe(true);
			expect(
				operations.some((instruction) =>
					["COPY_DATA_PROPERTIES", "MERGE_DATA_PROPERTIES"].includes(instruction.opcode),
				),
			).toBe(false);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("retains merging after an earlier member", () => {
		const out = inspect("return { extra, ...source };");
		expect(
			out.core.some((instruction) => instruction.opcode === "mergeDataProperties"),
		).toBe(true);
	});
});
