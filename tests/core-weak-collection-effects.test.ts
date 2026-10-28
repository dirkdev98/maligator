import { describe, expect, it } from "vitest";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const operations = [
	["WeakMap", "get"],
	["WeakMap", "has"],
	["WeakMap", "delete"],
	["WeakSet", "has"],
	["WeakSet", "delete"],
] as const;

function storedReceiver(brand: string, storage: string, use: string) {
	const body = `visit(receiver);return ${use};`;
	switch (storage) {
		case "local":
			return `function compute(visit,key){const receiver=new ${brand}();${body}}globalThis.compute=compute;`;
		case "global":
			return `const receiver=new ${brand}();function compute(visit,key){${body}}globalThis.compute=compute;`;
		case "private":
			return `class Holder{#value=new ${brand}();compute(visit,key){const receiver=this.#value;${body}}}globalThis.Holder=Holder;`;
		case "call":
			return `const make=function make(visit){for(let i=0;i<3;i++)visit();return new ${brand}();};function compute(visit,key){const receiver=make(visit);${body}}globalThis.compute=compute;`;
		case "record":
			return `const make=function make(visit){for(let i=0;i<3;i++)visit();return {payload:new ${brand}()};};function compute(visit,key){const receiver=make(visit).payload;${body}}globalThis.compute=compute;`;
		default:
			throw new Error(`Unknown storage ${storage}`);
	}
}

describe("weak collection receiver facts", () => {
	it.each(
		operations.flatMap(([brand, method]) =>
			["local", "global", "private", "call", "record"].map(
				(storage) => [brand, method, storage] as const,
			),
		),
	)("refines %s.%s through %s storage", (brand, method, storage) => {
		const operation = `${brand}.prototype.${method}`;
		const out = inspectStaticValueFunction(
			storedReceiver(brand, storage, `${operation}.call(receiver,key)`),
			"compute",
			{ realms: false },
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === operation,
		);
		expect(out.native.body.instructions[ip]).toMatchObject({ specialized: operation });
		expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toEqual({
			reads: ["object-property"],
			writes: method === "delete" ? ["object-property"] : [],
			mayThrow: false,
			mayGc: false,
			maySuspend: false,
			callsUserCode: false,
		});
		expect(out.core.some((op) => op.attributes.exactCollectionReceiver === brand)).toBe(
			true,
		);
	});

	it.each(operations)(
		"transports independent %s.%s guards through artifacts",
		(brand, method) => {
			const out = inspectStaticValueFunction(
				storedReceiver(brand, "global", `receiver.${method}(key)`),
				"compute",
				{ realms: false },
			);
			const index = out.image.native.functions.indexOf(out.native);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image))
				.native.functions[index]!;
			for (const fn of [out.native, restored]) {
				const ip = fn.instructions.findIndex(
					(plan) => plan?.kind === "call" && plan.exactCollectionReceiver === brand,
				);
				const call = fn.body.instructions[ip];
				if (call?.opcode !== "CALL") throw new Error("Missing guarded weak call");
				expect(fn.registerRepresentations[call.dst]).toBe("boxed");
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
				).toMatchObject({ exactCollectionReceiver: brand });
			}
		},
	);

	it.each(operations)(
		"elides the fresh %s.%s callee guard only for an isolated receiver",
		(brand, method) => {
			const out = inspectStaticValueFunction(
				`function compute(key){const receiver=new ${brand}();return receiver.${method}(key);}globalThis.compute=compute;`,
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
		},
	);

	it.each([
		["WeakMap", "new Proxy(new WeakMap(),{})"],
		["WeakMap", "new Map()"],
		["WeakMap", "key?new WeakMap():new Map()"],
		["WeakSet", "new Proxy(new WeakSet(),{})"],
		["WeakSet", "new Set()"],
	] as const)("retains %s validation for %s", (brand, value) => {
		const out = inspectStaticValueFunction(
			`function compute(visit,key){const receiver=${value};visit(receiver);return ${brand}.prototype.has.call(receiver,key);}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		expect(
			out.core.some((op) => op.attributes.exactCollectionReceiver !== undefined),
		).toBe(false);
	});

	it.each(["WeakMap", "WeakSet"])("keeps %s constructor mutation observable", (brand) => {
		const out = inspectStaticValueFunction(
			storedReceiver(brand, "call", `${brand}.prototype.has.call(receiver,key)`),
			"compute",
			{ realms: false, locked: false },
		);
		expect(out.core.some((op) => op.attributes.normalResultHeapBrand !== undefined)).toBe(
			false,
		);
		expect(
			out.core.some((op) => op.attributes.exactCollectionReceiver !== undefined),
		).toBe(false);
	});
});
