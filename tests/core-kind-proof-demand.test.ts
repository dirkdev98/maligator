import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_LOCAL_FACT_BUNDLE_ANALYSIS,
	buildCoreLocalFactIndex,
} from "../src/compiler/core/core-ir-provenance.ts";
import { analyzeCoreValueClasses } from "../src/compiler/core/core-ir-value-classes.ts";
import { analyzeCoreValueKinds } from "../src/compiler/core/core-ir-value-kinds.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../src/compiler/shared/compiler-value-kinds.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

describe("integer proof demand", () => {
	it("queries one long dependency chain without solving unrelated values or rereading edits", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [seed] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const chain = () => {
			let value = seed!;
			for (let index = 0; index < 5000; index++)
				value = builder.appendInstruction(entry, "move", [value])[0]!;
			return value;
		};
		const first = chain(),
			second = chain();
		builder.setTerminator(entry, { kind: "return", value: first });
		const fn = program.function(builder.finish(entry).function);
		const kinds = analyzeCoreValueKinds(fn, buildCoreControlFlow(program, fn.id));
		expect(kinds.kindMask(first)).toBe(COMPILER_VALUE_KIND_NUMBER);
		expect(kinds.latticeMask(second)).toBe(COMPILER_VALUE_KIND_NUMBER);
		expect(kinds.scalarKind(first)).toBe("number");
		expect(kinds.statistics.integerQueries).toBe(0);
		expect(kinds.statistics.integerValues).toBe(0);
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceInstruction(
			coreInstructionId(fn.kernel.valueDefinitionOwner(seed!)),
			"createNumber",
			[],
			{ attributes: { value: -0 } },
		);
		expect(kinds.exactScalar(first)).toBe("int32");
		expect(kinds.statistics.integerValues).toBe(5000);
		expect(kinds.exactScalar(first)).toBe("int32");
		expect(kinds.statistics.integerValues).toBe(5000);
		expect(kinds.exactScalar(second)).toBe("int32");
		expect(kinds.statistics.integerValues).toBe(10000);
		editor.commit();
		expect(
			analyzeCoreValueKinds(fn, buildCoreControlFlow(program, fn.id)).exactScalar(first),
		).toBe("number");
	});

	it.each([0, -0, -2147483648, 2147483647, 2147483648, NaN, Infinity])(
		"preserves integer boundaries for %s",
		(value) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program),
				entry = builder.createBlock();
			const [number] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value },
			});
			const [copy] = builder.appendInstruction(entry, "move", [number!]);
			builder.setTerminator(entry, { kind: "return", value: copy! });
			const fn = program.function(builder.finish(entry).function);
			const kinds = analyzeCoreValueKinds(fn, buildCoreControlFlow(program, fn.id));
			expect(kinds.scalarKind(copy!)).toBe("number");
			expect(kinds.exactScalar(copy!)).toBe(
				[0, -2147483648, 2147483647].includes(value) && !Object.is(value, -0)
					? "int32"
					: "number",
			);
		},
	);

	it.each(["integer", "negative-zero", "cycle", "bottom-bitwise"])(
		"preserves the least fixed point for a %s phi",
		(shape) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
			const left = builder.createBlock(),
				right = builder.createBlock();
			const merge = builder.createBlock([{ representation: "boxed" }]);
			const joined = inspectCoreBlockParameters(builder, merge)[0]!.value;
			const [one] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 1 },
			});
			builder.setTerminator(entry, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			const [other] = builder.appendInstruction(right, "createNumber", [], {
				attributes: { value: shape === "negative-zero" ? -0 : 2 },
			});
			const [bitwise] = builder.appendInstruction(right, "binary", [one!, other!], {
				attributes: { operator: "&" },
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: merge, arguments: [one!] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: {
					block: merge,
					arguments: [shape === "bottom-bitwise" ? bitwise! : other!],
				},
			});
			const [alias] = builder.appendInstruction(merge, "move", [joined]);
			builder.setTerminator(
				merge,
				shape === "cycle"
					? { kind: "jump", edge: { block: merge, arguments: [alias!] } }
					: { kind: "return", value: alias! },
			);
			const fn = program.function(builder.finish(entry).function);
			for (const reverse of [false, true]) {
				const kinds = analyzeCoreValueKinds(fn, buildCoreControlFlow(program, fn.id), {
					operationResultMask: (_instruction, output) =>
						shape === "bottom-bitwise" && output === bitwise ? 0 : undefined,
				});
				for (const value of reverse ? [alias!, joined] : [joined, alias!])
					expect(kinds.exactScalar(value)).toBe(shape === "integer" ? "int32" : "number");
			}
		},
	);

	it("honors supplied move sources, supplied masks and non-move forwarding", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program),
			entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [negativeZero] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: -0 },
		});
		const [overridden] = builder.appendInstruction(entry, "move", [negativeZero!]);
		const [masked] = builder.appendInstruction(entry, "move", [one!]);
		const [represented] = builder.appendInstruction(entry, "move", [one!], {
			outputRepresentations: ["f64"],
		});
		const [global] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: overridden! });
		const fn = program.function(builder.finish(entry).function);
		const kinds = analyzeCoreValueKinds(fn, buildCoreControlFlow(program, fn.id), {
			operationResultValue: (_instruction, output) =>
				output === overridden || output === global ? one : undefined,
			operationResultMask: (_instruction, output) =>
				output === masked ? COMPILER_VALUE_KIND_NUMBER : undefined,
		});
		expect(kinds.exactScalar(overridden!)).toBe("int32");
		for (const value of [masked!, represented!, global!])
			expect(kinds.exactScalar(value)).toBe("number");
	});
});

function lockedContext() {
	return {
		...programAnalysisContext(),
		facts: compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { primordials: "locked" } }),
		),
	};
}

function typedArrayProgram() {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [Array.from("buffer", (char) => char.charCodeAt(0))],
	});
	const builder = new CoreFunctionBuilder(program),
		entry = builder.createBlock();
	const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
		attributes: { intrinsic: "Float64Array" },
	});
	const [length] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 4 },
		outputRepresentations: ["f64"],
	});
	const [first] = builder.appendInstruction(entry, "construct", [callee!, length!]);
	const [alias] = builder.appendInstruction(entry, "move", [first!]);
	const [second] = builder.appendInstruction(entry, "construct", [callee!, length!]);
	const [key] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 0 },
		outputRepresentations: ["f64"],
	});
	builder.appendInstruction(entry, "loadProperty", [alias!, key!]);
	builder.appendInstruction(entry, "loadPropertyStatic", [second!], {
		attributes: { stringIndex: 0 },
	});
	const [nothing] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: nothing! });
	const fn = program.function(builder.finish(entry).function);
	const context = lockedContext();
	return {
		program,
		fn,
		context,
		first: first!,
		alias: alias!,
		second: second!,
		length: length!,
	};
}

describe("heap containment demand", () => {
	it("keeps external-buffer TypedArrays branded without attempting fixed-storage containment", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const buffer = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Float64Array" },
		});
		const [array] = builder.appendInstruction(entry, "construct", [callee!, buffer]);
		builder.setTerminator(entry, { kind: "return", value: array! });
		const fn = program.function(builder.finish(entry).function);
		const context = lockedContext();
		const classes = analyzeCoreValueClasses(program, fn.id, context, undefined, () => {
			throw new Error("Unneeded containment index");
		});
		expect(classes.exactNumericTypedArray(array!)).toBe("Float64Array");
		expect(classes.containedFixedNumericTypedArray(array!)).toBeUndefined();
		expect(classes.statistics.containmentChecks).toBe(0);
	});

	it.each(["Map", "Set"])("rejects retained mutator results for %s", (brand) => {
		for (const retained of [false, true]) {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program),
				entry = builder.createBlock();
			const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
				attributes: { intrinsic: brand },
			});
			const [collection] = builder.appendInstruction(entry, "construct", [callee!]);
			const [value] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [result] = builder.appendInstruction(
				entry,
				"callKnown",
				brand === "Map" ? [collection!, value!, value!] : [collection!, value!],
				{
					attributes: {
						operation: brand === "Map" ? "Map.prototype.set" : "Set.prototype.add",
					},
				},
			);
			if (retained) builder.appendInstruction(entry, "rootUse", [result!]);
			builder.setTerminator(entry, { kind: "return", value: value! });
			const fn = program.function(builder.finish(entry).function);
			const context = lockedContext();
			const classes = analyzeCoreValueClasses(program, fn.id, context);
			expect(classes.exactHeapBrand(collection!)).toBe(brand);
			expect(classes.containedCollection(collection!)).toBe(retained ? undefined : brand);
		}
	});

	it.each([false, true])(
		"rejects exception-handler captures with index=%s",
		(indexed) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program),
				entry = builder.createBlock(),
				body = builder.createBlock();
			const handler = builder.createBlock([
				{ representation: "boxed", role: "exception" },
				{ representation: "boxed" },
			]);
			const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
				attributes: { intrinsic: "Map" },
			});
			const [collection] = builder.appendInstruction(entry, "construct", [callee!]);
			const [nothing] = builder.appendInstruction(entry, "createUndefined", []);
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: body, arguments: [] },
			});
			builder.setHandler(body, handler, [collection!]);
			builder.appendInstruction(body, "call", [callee!, nothing!]);
			builder.setTerminator(body, { kind: "return", value: nothing! });
			builder.setTerminator(handler, { kind: "return", value: nothing! });
			const fn = program.function(builder.finish(entry).function);
			const context = lockedContext();
			const roots = coreCanonicalValueRoots(
				fn,
				buildCoreControlFlow(program, fn.id, { exceptions: true }),
			);
			const classes = analyzeCoreValueClasses(
				program,
				fn.id,
				context,
				roots,
				indexed ? () => buildCoreLocalFactIndex(fn, roots) : undefined,
			);
			expect(classes.exactHeapBrand(collection!)).toBe("Map");
			expect(classes.containedCollection(collection!)).toBeUndefined();
		},
	);

	it.each([false, true])(
		"checks only the requested root and memoizes aliases with index=%s",
		(indexed) => {
			const { program, fn, context, first, alias, second } = typedArrayProgram();
			const roots = coreCanonicalValueRoots(fn, buildCoreControlFlow(program, fn.id));
			let indexQueries = 0;
			const classes = analyzeCoreValueClasses(
				program,
				fn.id,
				context,
				roots,
				indexed
					? () => {
							indexQueries++;
							return buildCoreLocalFactIndex(fn, roots);
						}
					: undefined,
				() => {
					throw new Error("Unneeded range analysis");
				},
			);
			expect(classes.exactHeapBrand(first)).toBe("Float64Array");
			expect(classes.exactNumericTypedArray(second)).toBe("Float64Array");
			expect(classes.containedCollection(first)).toBeUndefined();
			expect(classes.statistics.containmentChecks).toBe(0);
			expect(indexQueries).toBe(0);
			expect(classes.containedFixedNumericTypedArray(first)).toBe("Float64Array");
			const visits = classes.statistics.useVisits;
			expect(classes.containedFixedNumericTypedArray(alias)).toBe("Float64Array");
			expect(classes.statistics.containmentChecks).toBe(1);
			expect(classes.statistics.useVisits).toBe(visits);
			expect(classes.containedFixedNumericTypedArray(second)).toBeUndefined();
			expect(classes.containedFixedNumericTypedArray(second)).toBeUndefined();
			expect(classes.statistics.containmentChecks).toBe(2);
			expect(indexQueries).toBe(indexed ? 1 : 0);
			expect(classes.exactHeapBrand(second)).toBe("Float64Array");
		},
	);

	it.each([false, true])(
		"rejects lazy reads during and after edits with cached=%s",
		(cached) => {
			const { program, fn, context, first, length } = typedArrayProgram();
			const classes = analyzeCoreValueClasses(program, fn.id, context);
			if (cached)
				expect(classes.containedFixedNumericTypedArray(first)).toBe("Float64Array");
			const editor = CoreEditor.open(program, fn.id);
			editor.setValueRepresentation(length, "boxed");
			expect(() => classes.containedFixedNumericTypedArray(first)).toThrow(
				"Stale value-class analysis",
			);
			editor.commit();
			expect(() => classes.exactHeapBrand(first)).toThrow("Stale value-class analysis");
			expect(analyzeCoreValueClasses(program, fn.id, context).exactHeapBrand(first)).toBe(
				"Float64Array",
			);
		},
	);

	it("keeps bundle brand queries independent of its use index and reports deferred containment", () => {
		const { program, fn, context, first } = typedArrayProgram();
		const report = new CoreOptimizationReportBuilder(program, "full");
		const analyses = new CoreAnalysisManager(program, context, report);
		const facts = analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, {
			scope: "function",
			function: fn.id,
		});
		expect(facts.valueClasses.exactNumericTypedArray(first)).toBe("Float64Array");
		expect(facts.valueClasses.statistics.containmentChecks).toBe(0);
		expect(facts.valueClasses.containedFixedNumericTypedArray(first)).toBe(
			"Float64Array",
		);
		expect(
			report.finish(program, { directEntries: [], specializations: [] }).counters
				.valueClassContainmentChecks,
		).toBe(1);
	});
});
