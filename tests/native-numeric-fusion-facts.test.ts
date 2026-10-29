import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_REGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_BIGINT,
	compilerNumberFastPathInputKind,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("primitive numeric fusion facts", () => {
	it.each([
		"(left+right)*other",
		"(left+right+value)*other",
		"(value+left)*right",
		"(left+right)*value",
	] as const)(
		"keeps a frameless entry alongside the full fusion for %s",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,flag,other){const value=flag?!!other:null;return ${expression};}globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			expect(
				out.native.specializations.some((region) => region.kind === "numeric-fusion"),
			).toBe(true);
			expect(out.c.trySymbol).toBeDefined();
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each([
		["start", "flag?!!other:null", "(value+left)*right", 1],
		["finish", "flag?!!other:null", "(left+right)*value", 1],
		["link", "flag?!!other:null", "(left+right+value)*other", 2],
		["String start", "flag?'2':!!other", "(value+left)*right", 1],
		["String link", "flag?'2':!!other", "(left+right+value)*other", 2],
		["String finish", "flag?'2':!!other", "(left+right)*value", 1],
		["String comparison", "flag?'2':'10'", "(left+right)<value", 1],
		["reversed String comparison", "flag?'2':'10'", "value<(left+right)", 1],
	] as const)(
		"consumes independent %s facts after artifact restoration",
		(_name, value, expression, pairs) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,flag,other,gate){gate();const value=${value};return ${expression};}globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			expect(restored).toEqual(out.image);
			const native = restored.native.functions[out.native.functionIndex]!;
			const fusion = native.specializations.find(
				(region) => region.kind === "numeric-fusion",
			);
			expect(fusion).toMatchObject({ runtimeGuard: "primitive-number-operands" });
			if (fusion?.kind !== "numeric-fusion") throw new Error("Missing primitive fusion");
			expect(fusion.pairs).toHaveLength(pairs);
			const primitiveInput = fusion.claimedIps.flatMap((ip) => {
				const facts = native.facts?.[ip];
				return (
					facts?.inputKindMasks?.flatMap((mask, index) =>
						(mask & COMPILER_VALUE_KIND_NUMBER) === 0 &&
						(mask &
							~(
								COMPILER_VALUE_KIND_BOOLEAN |
								COMPILER_VALUE_KIND_NULL |
								COMPILER_VALUE_KIND_STRING
							)) ===
							0
							? [facts.registers![facts.inputOffset! + index]!]
							: [],
					) ?? []
				);
			});
			expect(primitiveInput.length).toBeGreaterThan(0);
			for (const register of primitiveInput)
				expect(native.storage!.rootRegisters).not.toContain(register);
			const c = emitCompiledFunction(native, native.functionIndex, "", false)!;
			expect(c.source).toContain("__nf_");
		},
	);

	it.each([false, true])(
		"preserves suspension ownership when the phi precedes yield: %s",
		(beforeYield) => {
			const value = "const value=flag?!!other:null;";
			const out = inspectStaticValueFunction(
				`function* compute(left,right,flag,other){${beforeYield ? value : ""}yield 0;${beforeYield ? "" : value}return (left+right)*value;}globalThis.compute=compute;`,
				"compute",
				{ locked: false },
			);
			const fusion = out.native.specializations.find(
				(region) => region.kind === "numeric-fusion",
			);
			if (fusion?.kind !== "numeric-fusion") throw new Error("Missing resumable fusion");
			const finish = out.native.body.instructions[fusion.pairs.at(-1)!.finishIp];
			if (finish?.opcode !== "BINARY") throw new Error("Missing resumable product");
			expect(out.native.storage!.rootRegisters.includes(finish.right)).toBe(beforeYield);
			expect(out.c.source).toContain("__nf_");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each([
		["BigInt", COMPILER_VALUE_KIND_BIGINT],
		["Symbol", COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL],
		["Symbol.for", COMPILER_VALUE_KIND_REGISTERED_SYMBOL],
	] as const)(
		"retains managed %s alternatives while admitting the Number arm",
		(operation, kind) => {
			const out = inspectStaticValueFunction(
				`function compute(left,right,flag,other,gate){gate();const value=flag?+other:${operation}(other);return (left+right)*value;}globalThis.compute=compute;`,
				"compute",
			);
			const fusion = out.native.specializations.find(
				(region) => region.kind === "numeric-fusion",
			);
			if (fusion?.kind !== "numeric-fusion")
				throw new Error("Missing managed-arm fusion");
			const finishIp = fusion.pairs.at(-1)!.finishIp;
			const finish = out.native.body.instructions[finishIp];
			if (finish?.opcode !== "BINARY") throw new Error("Missing managed-arm product");
			expect(out.native.facts?.[finishIp]?.inputKindMasks?.[1]).toBe(
				COMPILER_VALUE_KIND_NUMBER | kind,
			);
			expect(out.native.storage!.rootRegisters).toContain(finish.right);
		},
	);

	it.each(["===", "!==", "==", "!="])(
		"retains Number-only equality admission for %s",
		(operator) => {
			expect(
				compilerNumberFastPathInputKind(
					operator,
					COMPILER_VALUE_KIND_BOOLEAN | COMPILER_VALUE_KIND_NUMBER,
				),
			).toBe(COMPILER_VALUE_KIND_NUMBER);
			expect(compilerNumberFastPathInputKind(operator, COMPILER_VALUE_KIND_STRING)).toBe(
				0,
			);
		},
	);

	it("rejects a mismatched numeric fusion guard contract after serialization", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right,other){return (left+right)*other;}globalThis.compute=compute;",
			"compute",
		);
		const malformed = {
			...out.image,
			native: {
				...out.image.native,
				functions: out.image.native.functions.map((native) =>
					native.functionIndex !== out.native.functionIndex
						? native
						: {
								...native,
								specializations: native.specializations.map((region) =>
									region.kind === "numeric-fusion"
										? { ...region, runtimeGuard: "int32-operands" as const }
										: region,
								),
							},
				),
			},
		};
		expect(() =>
			deserializeCompilerArtifact(serializeCompilerArtifact(malformed)),
		).toThrow(/numeric-fusion/);
	});

	it("keeps a typed entry's valid fusion prefix when a String tail cuts admission", () => {
		const out = inspectStaticValueFunction(
			"function compute(left,right,other,tail){return ((left+right)*other)+tail;}globalThis.compute=compute;globalThis.result=compute(globalThis.left,globalThis.right,globalThis.other,':');",
			"compute",
		);
		const fusion = out.native.specializations.find(
			(region) => region.kind === "numeric-fusion",
		);
		if (fusion?.kind !== "numeric-fusion") throw new Error("Missing canonical chain");
		expect(fusion.pairs).toHaveLength(2);
		expect(
			out.native.directEntries.some((entry) =>
				entry.instructionFacts?.some(
					({ masks }) => masks[1] === COMPILER_VALUE_KIND_STRING,
				),
			),
		).toBe(true);
		const source = out.c.directEntries[0]!.source;
		expect(source).toContain("__nf_");
		expect(source).toContain("mal_vm_concat_primitive_strings(");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});

	it("keeps coercion-capable kinds behind their original fallback", () => {
		const primitives = COMPILER_VALUE_KIND_BOOLEAN | COMPILER_VALUE_KIND_NULL;
		expect(
			compilerNumberFastPathInputKind("+", primitives | COMPILER_VALUE_KIND_STRING),
		).toBe(primitives);
		expect(
			compilerNumberFastPathInputKind("*", primitives | COMPILER_VALUE_KIND_STRING),
		).toBe(primitives | COMPILER_VALUE_KIND_STRING);
		expect(compilerNumberFastPathInputKind("<", COMPILER_VALUE_KIND_STRING)).toBe(
			COMPILER_VALUE_KIND_STRING,
		);
		expect(
			compilerNumberFastPathInputKind(
				"*",
				COMPILER_VALUE_KIND_BOOLEAN | COMPILER_VALUE_KIND_OBJECT,
			),
		).toBe(0);
	});
});
