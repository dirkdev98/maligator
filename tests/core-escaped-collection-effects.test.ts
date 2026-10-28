import { describe, expect, it } from "vitest";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
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

function storedReceiver(storage: "global" | "private", value: string, body: string) {
	return storage === "global"
		? `const collection=${value};function compute(observe,key){${body}}globalThis.compute=compute;`
		: `class Holder{#collection=${value};compute(observe,key){const collection=this.#collection;${body}}}globalThis.Holder=Holder;`;
}

describe("stored collection brands", () => {
	it.each([
		["global", "Map", "get"],
		["private", "Map", "get"],
		["global", "Set", "has"],
		["private", "Set", "has"],
	] as const)(
		"retains independent brand and callee facts for a %s %s.%s through artifact transport",
		(storage, brand, method) => {
			const out = inspectStaticValueFunction(
				storedReceiver(
					storage,
					`new ${brand}()`,
					`observe(collection);return collection.${method}(key);`,
				),
				"compute",
				{ realms: false },
			);
			const index = out.image.native.functions.indexOf(out.native);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image))
				.native.functions[index]!;
			for (const fn of [out.native, restored]) {
				expect(
					fn.specializations.find(
						(region) => region.kind === "builtin-collection-call-chain",
					),
				).toMatchObject({ calleeGuard: "required" });
				expect(
					fn.instructions.find(
						(plan) =>
							plan?.kind === "call" &&
							plan.guardedBuiltinCall?.operation.endsWith(`.${method}`),
					),
				).toMatchObject({ kind: "call", exactCollectionReceiver: brand });
			}
		},
	);

	it("keeps guard elision for an isolated fresh receiver through artifact transport", () => {
		const out = inspectStaticValueFunction(
			"function compute(key){const collection=new Map();return collection.get(key);}globalThis.compute=compute;",
			"compute",
			{ realms: true },
		);
		const index = out.image.native.functions.indexOf(out.native);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image))
			.native.functions[index]!;
		for (const fn of [out.native, restored])
			expect(
				fn.specializations.find(
					(region) => region.kind === "builtin-collection-call-chain",
				),
			).toMatchObject({ calleeGuard: "elided" });
	});

	it("uses a published local Map brand without eliding its callee guard", () => {
		const out = inspectStaticValueFunction(
			"function compute(visit,key){const collection=new Map();visit(collection);return collection.get(key);}globalThis.compute=compute;",
			"compute",
			{ realms: true },
		);
		expect(
			out.native.specializations.find(
				(region) => region.kind === "builtin-collection-call-chain",
			),
		).toMatchObject({ calleeGuard: "required" });
		expect(
			out.native.instructions.find(
				(plan) =>
					plan?.kind === "call" &&
					plan.guardedBuiltinCall?.operation === "Map.prototype.get",
			),
		).toMatchObject({ exactCollectionReceiver: "Map" });
	});

	it.each([
		["global", "Map", "get"],
		["global", "Set", "has"],
		["private", "Map", "get"],
		["private", "Set", "has"],
	] as const)("carries a %s %s into captured %s effects", (storage, brand, method) => {
		const operation = `${brand}.prototype.${method}`;
		const out = inspectStaticValueFunction(
			storedReceiver(
				storage,
				`new ${brand}()`,
				`observe(collection);return ${operation}.call(collection,key);`,
			),
			"compute",
			{ realms: false },
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
		);
		const call = out.native.body.instructions[ip];
		if (call?.opcode !== "CALL_KNOWN") throw new Error("Missing stored collection call");
		expect(call.specialized).toBe(operation);
		expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toEqual({
			reads: ["object-property"],
			writes: [],
			mayThrow: false,
			maySuspend: false,
			mayGc: false,
			callsUserCode: false,
		});
	});

	it.each(["global", "private"] as const)(
		"keeps receiver failure for a Proxy in a %s slot",
		(storage) => {
			const out = inspectStaticValueFunction(
				storedReceiver(
					storage,
					"new Proxy(new Map(),{})",
					"observe(collection);return Map.prototype.get.call(collection,key);",
				),
				"compute",
				{ realms: false },
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === "Map.prototype.get",
			);
			const call = out.native.body.instructions[ip];
			if (call?.opcode !== "CALL_KNOWN") throw new Error("Missing stored Proxy call");
			expect(call.specialized).toBeUndefined();
			expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!).mayThrow).toBe(
				true,
			);
		},
	);

	it.each(["global", "private"] as const)(
		"keeps constructor and method fallbacks with mutable primordials in a %s slot",
		(storage) => {
			const out = inspectStaticValueFunction(
				storedReceiver(
					storage,
					"new Map()",
					"observe(collection);return Map.prototype.get.call(collection,key);",
				),
				"compute",
				{ realms: false, locked: false },
			);
			expect(
				out.core.some((op) => op.attributes.exactCollectionReceiver !== undefined),
			).toBe(false);
		},
	);
});
