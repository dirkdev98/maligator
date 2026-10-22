import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";

const fixture = path.resolve("tests/local/private-field-arrays.mjs");

function accessPlansByFunction(): ReadonlyMap<string, ReadonlyArray<string>> {
	const image = compileEntrypoint(fixture, {
		buildConfig: resolveBuildConfig({
			engine: { primordials: "locked", eval: false, realms: false },
		}),
	});
	const plans = new Map<string, Array<string>>();
	for (const fn of image.native.functions) {
		const name = String.fromCharCode(
			...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
		);
		const kinds = plans.get(name) ?? [];
		fn.body.instructions.forEach((instruction, ip) => {
			if (
				instruction.opcode === "LOAD_PROPERTY" ||
				instruction.opcode === "STORE_PROPERTY" ||
				instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH"
			)
				kinds.push(`${instruction.opcode} ${fn.instructions[ip]?.kind ?? "ordinary"}`);
		});
		plans.set(name, kinds);
	}
	return plans;
}

describe("private fields of one class", () => {
	const plans = accessPlansByFunction();

	it("let element and length accesses skip the class test", () => {
		expect(plans.get("mark")).toContain("LOAD_PROPERTY exact-array-element");
		expect(plans.get("setMark")).toContain("STORE_PROPERTY exact-array-element");
		expect(plans.get("size")).toContain(
			"LOAD_PROPERTY_STATIC_ARRAY_LENGTH exact-array-length",
		);
		expect(plans.get("count")).toContain("LOAD_PROPERTY exact-typed-array-element");
	});

	it("keep the class test when a read can see the field before its array", () => {
		expect(plans.get("second")).toContain("LOAD_PROPERTY ordinary");
	});
});
