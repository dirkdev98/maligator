import { describe, expect, it } from "vitest";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("exact collection brands after publication", () => {
	it.each([
		["Map", "get", false, false],
		["Map", "set", true, true],
		["Map", "has", false, false],
		["Map", "delete", true, false],
		["Set", "add", true, true],
		["Set", "has", false, false],
		["Set", "delete", true, false],
	] as const)(
		"retains %s.%s heap effects while removing receiver failure",
		(brand, method, writes, mayGc) => {
			const operation = `${brand}.prototype.${method}`;
			const out = inspectStaticValueFunction(
				`function compute(observe,key,value){const receiver=new ${brand}();observe(receiver);return ${operation}.call(receiver,key,value);}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
			);
			const call = out.native.body.instructions[ip];
			if (call?.opcode !== "CALL_KNOWN") throw new Error("Missing collection call");
			expect(call.specialized).toBe(operation);
			expect(
				out.core.find((op) => op.attributes.operation === operation)?.attributes
					.exactCollectionReceiver,
			).toBe(brand);
			expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toEqual({
				reads: ["object-property"],
				writes: writes ? ["object-property"] : [],
				mayThrow: false,
				maySuspend: false,
				mayGc,
				callsUserCode: false,
			});
			expect(out.native.body.instructions.some((op) => op.opcode === "CALL")).toBe(true);
		},
	);

	it.each([
		["new Proxy(new Map(),{})", "Map"],
		["new Set()", "Map"],
		["new Map()", "Set"],
		["key ? new Map() : new Set()", "Map"],
		["key", "Map"],
	] as const)("keeps receiver validation for %s passed to %s.has", (receiver, brand) => {
		const operation = `${brand}.prototype.has`;
		const out = inspectStaticValueFunction(
			`function compute(observe,key){const receiver=${receiver};observe(receiver);return ${operation}.call(receiver,key);}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
		);
		const call = out.native.body.instructions[ip];
		if (call?.opcode !== "CALL_KNOWN") throw new Error("Missing collection fallback");
		expect(call.specialized).toBeUndefined();
		expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!).mayThrow).toBe(
			true,
		);
	});
});
