import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(
	payload: string,
	use: string,
	reader = "const payload=record.payload;visit(payload);",
	declaration = "function",
) {
	return inspectStaticValueFunction(
		`const make=function make(visit,flag){for(let i=0;i<3;i++)visit();return {payload:${payload},tag:1};};${declaration} compute(visit,key,flag){const record=make(visit,flag);${reader}return ${use};}globalThis.compute=compute;`,
		"compute",
		{ realms: false },
	);
}

describe("record heap brands through lowering", () => {
	it.each([
		["const record={payload:flag};record.payload=new Map();return record;", "Map"],
		[
			"const record={payload:new Map()};if(flag)record.payload=new Map();return record;",
			"Map",
		],
		[
			"const record={payload:new Map()};if(flag)record.payload=new Set();return record;",
			undefined,
		],
	] as const)(
		"joins resolved constructor identities across producer writes in %s",
		(body, expected) => {
			const out = inspectStaticValueFunction(
				`const make=function make(visit,flag){for(let i=0;i<3;i++)visit();${body}};function compute(visit,key,flag){const record=make(visit,flag);return Map.prototype.get.call(record.payload,key);}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			const calls = out.core.filter(
				(op) => op.attributes.operation === "Map.prototype.get",
			);
			expect(calls).not.toHaveLength(0);
			expect(
				calls.every((op) => op.attributes.exactCollectionReceiver === expected),
			).toBe(true);
		},
	);

	it.each([
		["Map", "flag?new Map():new Map()", "Map.prototype.get.call(payload,key)"],
		["Set", "new Set()", "Set.prototype.has.call(payload,key)"],
		["Array", "[]", "Array.isArray(payload)"],
		["Uint8Array", "new Uint8Array(4)", "payload[key]"],
	] as const)(
		"transports a normal %s field without discarding producer effects",
		(brand, value, use) => {
			const out = inspect(value, use);
			expect(
				out.core.some(
					(op) =>
						op.opcode === "loadPropertyStatic" &&
						op.attributes.normalResultHeapBrand === brand,
				),
			).toBe(true);
			if (brand === "Array")
				expect(out.core.some((op) => op.attributes.operation === "Array.isArray")).toBe(
					false,
				);
			else if (brand === "Uint8Array")
				expect(out.core.some((op) => op.attributes.exactTypedArrayKind === brand)).toBe(
					true,
				);
			else
				expect(
					out.core.some((op) => op.attributes.exactCollectionReceiver === brand),
				).toBe(true);
			expect(
				out.native.body.instructions.filter((op) => op.opcode === "CALL").length,
			).toBeGreaterThanOrEqual(2);
		},
	);

	it.each(["function", "function*", "async function", "async function*"])(
		"keeps payload brands across %s reader suspension",
		(declaration) => {
			const suspend =
				(declaration.includes("*") ? "yield record.payload;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspect(
				"new Map()",
				"Map.prototype.get.call(payload,key)",
				`${suspend}const payload=record.payload;visit(payload);`,
				declaration,
			);
			expect(out.core.some((op) => op.attributes.exactCollectionReceiver === "Map")).toBe(
				true,
			);
		},
	);

	it.each([
		["new Proxy(new Map(),{})", "const payload=record.payload;"],
		["flag?new Map():new Set()", "const payload=record.payload;"],
		["new Map()", "visit(record);const payload=record.payload;"],
		[
			"new Map()",
			"Object.defineProperty(record,'payload',{get(){return key;}});const payload=record.payload;",
		],
		["new Map()", "if(flag)record.payload=new Set();const payload=record.payload;"],
	] as const)("retains validation for %s with %s", (payload, reader) => {
		const out = inspect(payload, "Map.prototype.get.call(payload,key)", reader);
		expect(
			out.core.some((op) => op.attributes.exactCollectionReceiver !== undefined),
		).toBe(false);
	});

	it("preserves a loaded-callee guard through the compiler artifact", () => {
		const out = inspect("new Map()", "payload.get(key)");
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
						plan.guardedBuiltinCall?.operation === "Map.prototype.get",
				),
			).toMatchObject({ exactCollectionReceiver: "Map" });
		}
	});
});
