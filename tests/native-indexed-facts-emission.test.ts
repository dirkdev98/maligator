import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import type { InstructionFacts } from "../src/compiler/shared/instruction-facts.ts";
import { COMPILER_INT32_RANGE } from "../src/compiler/shared/integer-range.ts";
import type { CompilerIntegerRange } from "../src/compiler/shared/integer-range.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type {
	NativeInstructionPlan,
	VmRegisterRepresentation,
} from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const template = inspectStaticValueFunction(
	"function access(source,key,value){return source[key];}globalThis.access=access;",
	"access",
).fn;
function emit(
	store: boolean,
	keyKind: number,
	options: {
		plan?: NativeInstructionPlan;
		valueKind?: number;
		result?: VmRegisterRepresentation;
		range?: CompilerIntegerRange;
		resumable?: boolean;
	} = {},
) {
	const instructions: Array<BytecodeInstruction> = [
		...(options.resumable ? [{ opcode: "GENERATOR_START" } as const] : []),
		store
			? { opcode: "STORE_PROPERTY", object: 0, key: 1, value: 2, icIndex: 0 }
			: { opcode: "LOAD_PROPERTY", object: 0, key: 1, dst: 3, icIndex: 0 },
		{ opcode: "RETURN", value: store ? 2 : 3 },
	];
	const body = {
		...template,
		isGenerator: options.resumable ?? false,
		parameterCount: 3,
		registerCount: 4,
		propertyIcCount: 1,
		instructions,
		positions: instructions.map(() => 0),
	};
	const native = createConservativeNativePlan([body]).functions[0]!;
	const representations = [...native.registerRepresentations];
	representations[3] = options.result ?? "boxed";
	const facts: InstructionFacts = store
		? {
				registers: [0, 1, 2],
				inputOffset: 0,
				inputKindMasks: [
					COMPILER_VALUE_KIND_OBJECT,
					keyKind,
					options.valueKind ?? COMPILER_VALUE_KIND_TOP,
				],
				resultKindMasks: [],
				inputIntegerRanges: [undefined, options.range, undefined],
			}
		: {
				registers: [3, 0, 1],
				inputOffset: 1,
				inputKindMasks: [COMPILER_VALUE_KIND_OBJECT, keyKind],
				resultKindMasks: [
					options.result === "number"
						? COMPILER_VALUE_KIND_NUMBER
						: COMPILER_VALUE_KIND_TOP,
				],
				inputIntegerRanges: [undefined, options.range],
			};
	const liveRoots = (roots: ReadonlyArray<number>) =>
		roots.filter(
			(r) => representations[r] === "boxed" || representations[r] === "string",
		);
	const lowered = lowerNativeFunctionStorage({
		...native,
		registerRepresentations: representations,
		facts: [...(options.resumable ? [undefined] : []), facts, undefined],
		instructions: [...(options.resumable ? [undefined] : []), options.plan, undefined],
		gc: {
			safepoints: native.gc.safepoints.map((p) => ({
				...p,
				rootRegisters: liveRoots(p.rootRegisters),
				incomingRootRegisters: liveRoots(p.incomingRootRegisters),
				outgoingRootRegisters: liveRoots(p.outgoingRootRegisters),
			})),
		},
	});
	return emitCompiledFunction(lowered, 0, "", false)!.source;
}

describe("indexed property operand facts through boxed storage", () => {
	it.each([false, true])("uses boxed Number indices in resumable store=%s", (store) => {
		const c = emit(store, COMPILER_VALUE_KIND_NUMBER, { resumable: true });
		expect(c).toContain(
			store ? "mal_vm_indexed_fast_store_index(" : "mal_vm_indexed_fast_load_index(",
		);
		expect(c).toContain("mal_ops_number_as_f64(r1)");
	});
	it.each([false, true])("selects the Number path for store=%s", (store) => {
		const c = emit(store, COMPILER_VALUE_KIND_NUMBER);
		expect(c).toContain(
			store ? "mal_vm_indexed_fast_store_index(" : "mal_vm_indexed_fast_load_index(",
		);
		expect(c).toContain("mal_ops_number_as_f64(r1)");
		expect(c).not.toContain(
			store ? "mal_vm_array_try_store_value_index(" : "mal_vm_array_try_get_value_index(",
		);
	});
	it.each([false, true])("uses integer bounds for store=%s", (store) => {
		for (const range of [COMPILER_INT32_RANGE, { ...COMPILER_INT32_RANGE, minimum: 0 }]) {
			const c = emit(store, COMPILER_VALUE_KIND_NUMBER, { range });
			expect(c).toContain(
				store
					? "mal_vm_array_try_store_proven_index("
					: "mal_vm_array_try_get_proven_index(",
			);
			expect(c.includes(">= 0")).toBe(range.minimum < 0);
		}
	});
	it.each([false, true])(
		"retains uncertain keys and removes impossible numeric probes for store=%s",
		(store) => {
			const mixed = emit(store, COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING);
			expect(mixed).toContain(
				store
					? "mal_vm_array_try_store_value_index("
					: "mal_vm_array_try_get_value_index(",
			);
			const named = emit(store, COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL);
			expect(named).toContain(
				store ? "mal_vm_indexed_fast_store(" : "mal_vm_indexed_fast_load(",
			);
			expect(named).not.toContain(
				store ? "mal_vm_array_try_store" : "mal_vm_array_try_get",
			);
		},
	);
	it("checks a throwing miss before decoding its scalar result", () => {
		const c = emit(false, COMPILER_VALUE_KIND_NUMBER, { result: "number" });
		const call = c.indexOf("mal_vm_indexed_fast_load_index(");
		const checked = c.indexOf("if (MAL_THREW())", call);
		const decoded = c.indexOf("mal_ops_number_as_f64(__boxed_load_", call);
		expect(call).toBeGreaterThan(0);
		expect(checked).toBeGreaterThan(call);
		expect(decoded).toBeGreaterThan(checked);
	});
	it.each(["exact-typed-array-element", "contained-fixed-typed-array-element"] as const)(
		"uses boxed Number proofs with %s",
		(kind) => {
			const plan = { kind, elementKind: "Float64Array" } as const;
			for (const store of [false, true]) {
				const c = emit(store, COMPILER_VALUE_KIND_NUMBER, {
					plan,
					valueKind: COMPILER_VALUE_KIND_NUMBER,
				});
				expect(c).not.toContain("mal_ops_is_number(r1)");
				expect(c).toContain("mal_ops_number_as_f64(r1)");
				if (kind === "contained-fixed-typed-array-element" && store) {
					expect(c).toContain("mal_scalar_f64_to_bits(mal_ops_number_as_f64(r2))");
					expect(c).not.toContain("mal_vm_numeric_typed_array_store_known_receiver(");
				}
			}
			for (const store of [false, true]) {
				const c = emit(store, COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL, {
					plan,
				});
				expect(c).not.toContain("mal_ops_number_as_f64(r1)");
				expect(c).not.toContain("mal_ops_is_number(r1)");
			}
		},
	);
	it("decodes boxed exact TypedArray results into scalar storage", () => {
		const c = emit(false, COMPILER_VALUE_KIND_NUMBER, {
			plan: { kind: "exact-typed-array-element", elementKind: "Float64Array" },
			result: "number",
		});
		expect(c).toContain("mal_ops_number_as_f64(mal_vm_exact_numeric_typed_array_load(");
	});
	it("decodes a boxed index for a contained Array read", () => {
		const c = emit(false, COMPILER_VALUE_KIND_NUMBER, {
			plan: { kind: "exact-contained-array-element" },
		});
		expect(c).toContain("mal_vm_private_array_try_get_index(");
		expect(c).toContain("mal_ops_number_as_f64(r1)");
	});
});
