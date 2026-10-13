import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.classify=function(source,escape,observe){${body}};`,
			"/split-span.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
const body = `const part=source.split('|')[1]; const size=part.length;
 if(part==='if')return size+10; if(escape)return observe(part); return size;`;
describe("span continuations from split projections", () => {
	it.each(["mutable", "locked"] as const)(
		"composes branching consumers under %s primordials",
		(mode) => {
			const image = compile(body, mode),
				native = image.native.functions[1]!;
			expect(native.storage!.spanContinuations).toHaveLength(1);
			expect(
				native.storage!.spanContinuations[0]!.consumers.map((value) => value.kind).sort(),
			).toEqual(["equal", "length", "materialize"]);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("composes character access with the original source span", () => {
		const image = compile(
			"const part=source.split('|')[1];if(part.length===2)return part==='if';return part.charCodeAt(0);",
		);
		const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
		expect(plan.consumers.map((value) => value.kind)).toContain("charCodeAtCall");
		expect(plan.consumers.map((value) => value.kind)).not.toContain("materialize");
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
	it.each(["mutable", "locked"] as const)(
		"composes numeric and character consumers under %s primordials",
		(mode) => {
			const image = compile(
				"const part=source.split('|')[1]; return part.charCodeAt(escape)+Number(part);",
				mode,
			);
			const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
			expect(plan.consumers.map((value) => value.kind)).toEqual(
				expect.arrayContaining(["charCodeAtCall", "number"]),
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it("uses the locked character chain's identity and retains its coercing fallback admission", () => {
		const image = compile(
			"const part=source.split('|')[1]; return part.charCodeAt(escape)+Number(part);",
			"locked",
		);
		const native = image.native.functions[1]!;
		const chain = native.specializations.find(
			(region) => region.kind === "string-char-code-at-chain",
		)!;
		expect(chain.methodIdentity).toBe("authority-invariant");
		const emitted = emitCompiledFunction(native, 1, "", false)!.source;
		expect(emitted).toContain(
			"mal_builtin_string_span_character(vm, MAL_VALUE_UNDEFINED, true,",
		);
		expect(emitted).toContain(`__string_char_code_at_${chain.callIp}_captured = true;`);
	});
	it("rejects omitted observers and a forged producer lifetime", () => {
		const image = compile(body),
			native = image.native.functions[1]!,
			plan = native.storage!.spanContinuations[0]!;
		for (const forged of [
			{ ...plan, consumers: plan.consumers.slice(0, 1) },
			{ ...plan, sourceCallIp: plan.producerIp },
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it.each([
		["charCodeAtProperty", "charCodeAtCall"],
		["charCodeAtCall", "charCodeAtProperty"],
		["number", "charCodeAtCall"],
		["charCodeAtProperty", "codePointAtProperty"],
		["charCodeAtCall", "codePointAtCall"],
		["charCodeAtCall", "charAtCall"],
		["charCodeAtCall", "atCall"],
	] as const)("rejects a %s continuation forged as %s", (original, kind) => {
		const image = compile(
			"const part=source.split('|')[1]; return part.charCodeAt(escape)+Number(part);",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		expect(plan.consumers.some((consumer) => consumer.kind === original)).toBe(true);
		expect(() =>
			serializeCompilerArtifact({
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(1, {
						...native,
						storage: {
							...native.storage!,
							spanContinuations: [
								{
									...plan,
									consumers: plan.consumers.map((consumer) =>
										consumer.kind === original ? { ...consumer, kind } : consumer,
									),
								},
							],
						},
					}),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it.each(["escape ? 0 : 1", "observe()"])(
		"retains captured code-point identity across argument evaluation: %s",
		(argument) => {
			const image = compile(
				`const part=source.split('|')[1]; return [part.codePointAt(${argument}),part.length];`,
			);
			const [plan] = image.native.functions[1]!.storage!.spanContinuations;
			expect(plan!.consumers.map((c) => c.kind)).toContain("codePointAtCall");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it("materializes before an observing store while retaining projected reads", () => {
		const image = compile(
			"const part=source.split('|')[1];observe.saved=part;return part.length;",
		);
		expect(
			image.native.functions[1]!.storage!.spanContinuations[0]!.consumers.map(
				(value) => value.kind,
			),
		).toEqual(["materialize", "length"]);
	});
	it("materializes a split field used as its own character position", () => {
		const image = compile(
			"const part=source.split('|')[1]; return part.charCodeAt(part)+part.length;",
		);
		const plan = image.native.functions[1]!.storage!.spanContinuations[0]!;
		expect(plan.consumers.map((value) => value.kind)).toContain("materialize");
		expect(plan.consumers.map((value) => value.kind)).not.toContain("charCodeAtCall");
		expect(() => serializeCompilerArtifact(image)).not.toThrow();
	});
});

describe("span continuations from regexp captures", () => {
	it.each(["mutable", "locked"] as const)(
		"shares code-point consumers across split and capture spans under %s primordials",
		(mode) => {
			for (const producer of ["source.split('|')[1]", "observe.exec(source)[1]"]) {
				const image = compile(
					`const part=${producer}; if(part===undefined)return -1;
 const point=part.codePointAt(escape); if(point===undefined)return part; return point+part.length+part.charCodeAt(0);`,
					mode,
				);
				const native = image.native.functions[1]!;
				const [plan] = native.storage!.spanContinuations;
				expect(plan).toBeDefined();
				expect(plan!.consumers.map((consumer) => consumer.kind)).toContain(
					"codePointAtCall",
				);
				const emitted = emitCompiledFunction(native, 1, "", false)!.source;
				expect(emitted).toContain("MAL_STRING_CHARACTER_CODE_POINT_AT");
				expect(emitted).toContain("mal_builtin_string_span_character(");
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);

	const capture = `const match=observe.exec(source); if(match===null)return -1;
 const part=match[1]; if(part===undefined)return 0; const size=part.length;
 if(escape)return part; return part.charCodeAt(0)+Number(part)+size;`;
	it.each(["mutable", "locked"] as const)(
		"composes capture consumers under %s primordials",
		(mode) => {
			const image = compile(capture, mode);
			const native = image.native.functions[1]!;
			expect(native.storage!.spanContinuations).toHaveLength(1);
			const plan = native.storage!.spanContinuations[0]!;
			expect(plan.sourceKind).toBe("regexp");
			expect(plan.consumers.map((consumer) => consumer.kind)).toEqual(
				expect.arrayContaining([
					"equal",
					"length",
					"charCodeAtCall",
					"number",
					"materialize",
				]),
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			expect(() => emitProgramImage(image, {})).not.toThrow();
		},
	);
	it("rejects a forged capture source and omitted observer", () => {
		const image = compile(capture);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		for (const forged of [
			{ ...plan, sourceKind: "split" as const },
			{ ...plan, sourceCallIp: plan.producerIp },
			{
				...plan,
				consumers: plan.consumers.filter((consumer) => consumer.kind !== "materialize"),
			},
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it.each(["mutable", "locked"] as const)(
		"materializes a capture retained across its producer's next execution under %s primordials",
		(mode) => {
			const image = compile(
				`let prior=""; let total=0;
 for(let i=0;i<2;i++) {
 const match=observe.exec(source); if(match===null)return total;
 const part=match[1]; total+=prior.length; prior=part; total+=part.length;
 } return total;`,
				mode,
			);
			const native = image.native.functions[1]!;
			const projection = native.specializations.find(
				(region) => region.kind === "regexp-exec-projection",
			)!;
			expect(projection).toBeDefined();
			expect(projection.loads).toHaveLength(1);
			expect(projection.loads[0]!.consumer).toBeUndefined();
			expect(native.storage!.spanContinuations).toHaveLength(0);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each([
		"prior=upper; total+=upper.toLowerCase().length;",
		"const lower=upper.toLowerCase(); prior=lower; total+=lower.length;",
	])("materializes retained case-chain intermediates: %s", (tail) => {
		const image = compile(`let prior=""; let total=0;
 for(let i=0;i<3;i++) {
 const match=observe.exec(source); if(match===null)break;
 const upper=match[1].toUpperCase(); total+=prior.length; ${tail}
 } return total;`);
		const native = image.native.functions[1]!;
		const projection = native.specializations.find(
			(region) => region.kind === "regexp-exec-projection",
		)!;
		expect(projection).toBeDefined();
		expect(projection.loads[0]!.consumer).toBeUndefined();
		expect(() => emitProgramImage(image, {})).not.toThrow();
	});
});

describe("bounded nested range continuations", () => {
	it.each(["mutable", "locked"] as const)(
		"composes relative range bounds under %s primordials",
		(mode) => {
			for (const producer of [
				"source.slice(1,-1)",
				"source.substring(1,9)",
				"source.split('|')[1]",
				"observe.exec(source)[1]",
			]) {
				const image = compile(
					`const parent=${producer}; const child=parent.substring(escape,3); const size=child.length; if(escape)return child; return size+child.codePointAt(0)+parent.length;`,
					mode,
				);
				const native = image.native.functions[1]!;
				const plan = native.storage!.spanContinuations.find((entry) =>
					entry.consumers.some((consumer) => consumer.kind === "rangeCall"),
				);
				expect(plan, producer).toBeDefined();
				expect(plan!.consumers.map((consumer) => consumer.kind)).toContain("length");
				const child = plan!.consumers.find((consumer) => consumer.kind === "rangeCall")!;
				expect(
					native.specializations.find(
						(region) => region.kind === "string-span" && region.callIp === child.ip,
					),
				).toMatchObject({ kind: "string-span", rangeOperation: "substring" });
				expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
					image,
				);
			}
		},
	);
	it("rejects forged relative operations and removed parent observers", () => {
		const image = compile(
			"const parent=source.slice(1,-1); const child=parent.substring(escape,3); return child.length+parent.length;",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.spanContinuations[0]!;
		expect(plan?.sourceKind).toBe("range");
		for (const forged of [
			{ ...plan, rangeOperation: "substring" as const },
			{ ...plan, sourceKind: "split" as const },
			{
				...plan,
				consumers: plan.consumers.map((consumer) =>
					consumer.kind === "rangeCall"
						? { ...consumer, kind: "materialize" as const }
						: consumer,
				),
			},
			{
				...plan,
				consumers: plan.consumers.map((consumer) =>
					consumer.kind === "rangeCall"
						? { ...consumer, value: consumer.value + 1 }
						: consumer,
				),
			},
			{
				...plan,
				consumers: plan.consumers.filter((consumer) => consumer.kind !== "length"),
			},
		]) {
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, spanContinuations: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
		}
	});
	it("declines mixed branch receivers without losing the certified child", () => {
		const image = compile(
			"const parent=source.slice(1,-1); const chosen=escape?parent:source; const child=chosen.substring(0,2); return child.length;",
		);
		const native = image.native.functions[1]!;
		expect(native.specializations.some((region) => region.kind === "string-span")).toBe(
			true,
		);
		expect(
			native.storage!.spanContinuations.every(
				(plan) => !plan.consumers.some((consumer) => consumer.kind === "rangeCall"),
			),
		).toBe(true);
	});
	it("declines a child bound that observes its virtual parent", () => {
		const image = compile(
			"const parent=source.slice(1,-1); const child=parent.substring(parent,3); return child.length+parent.length;",
		);
		expect(
			image.native.functions[1]!.storage!.spanContinuations.every(
				(plan) => plan.sourceKind !== "range",
			),
		).toBe(true);
	});
	it("declines a capture retained across its next exec before slicing", () => {
		const image = compile(
			`let prior=""; let result=0; for(let i=0;i<3;i++){ const part=observe.exec(source)[1]; const child=prior.slice(1); result+=child.length; prior=part; }return result;`,
		);
		expect(
			image.native.functions[1]!.storage!.spanContinuations.every(
				(plan) => !plan.consumers.some((consumer) => consumer.kind === "rangeCall"),
			),
		).toBe(true);
	});
});

describe("string character continuation results", () => {
	it.each(["mutable", "locked"] as const)(
		"keeps string outputs rooted across projected and nested spans under %s primordials",
		(mode) => {
			for (const producer of [
				"source.split('|')[1]",
				"observe.exec(source)[1]",
				"source.slice(1,-1).substring(0,2)",
			])
				for (const method of ["charAt", "at"] as const) {
					const image = compile(
						`const kept=observe();const part=${producer};${producer.includes(".slice(") ? "" : "if(part===undefined)return kept;"}const character=part.${method}(escape);observe();return [kept,character,part.length];`,
						mode,
					);
					const native = image.native.functions[1]!;
					const consumers = [
						...native.storage!.spanContinuations.flatMap((plan) => plan.consumers),
						...native.specializations.flatMap((region) =>
							region.kind === "string-span" ? region.consumers : [],
						),
					];
					const consumer = consumers.find((value) => value.kind === `${method}Call`)!;
					expect(consumer, producer).toBeDefined();
					const call = native.body.instructions[consumer.ip]!;
					if (call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN")
						throw new Error("character call missing");
					const point = native.gc.safepoints.find(
						(point) => point.instructionIp === consumer.ip,
					)!;
					const retained = native.body.instructions.find(
						(instruction) => instruction.opcode === "CALL",
					)!;
					if (retained.opcode !== "CALL") throw new Error("retained call missing");
					expect(point.incomingRootRegisters).toContain(retained.dst);
					expect(point.outgoingRootRegisters).toContain(call.dst);
					expect(native.storage!.rootRegisters).toContain(call.dst);
					const emitted = emitCompiledFunction(native, 1, "", false)!.source;
					expect(emitted).toContain("mal_builtin_string_span_character(vm,");
					expect(emitted).toContain(
						`MAL_STRING_CHARACTER_${method === "at" ? "AT" : "CHAR_AT"}`,
					);
					expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
						image,
					);
				}
		},
	);
});
