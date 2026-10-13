import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { selectNativeFastPaths } from "../src/compiler/target/lower-native-fast-paths.ts";
import type { NativeNumericLoopRegionPlan } from "../src/compiler/target/lower-native-fast-paths.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

function compile(body: string) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel=function(left,right,output,count,hook){${body}};`,
			"/typed-loop.js",
		),
	);
}
const body = "for(let i=0;i<count;i++){output[i]=left[i]+right[i];}return output;";
describe("fixed TypedArray loop storage", () => {
	it("composes a complete numeric fusion inside a fixed storage region", () => {
		const image = compile(
			"for(let i=0;i<count;i++){left[i]=left[i]*right+hook;}return left;",
		);
		const native = image.native.functions[1]!;
		const fusion = native.specializations.find(
			(region) => region.kind === "numeric-fusion",
		);
		if (fusion?.kind !== "numeric-fusion") throw new Error("Missing numeric fusion");
		const plan = native.storage!.numericLoopRegions[0];
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing numeric storage region");
		expect(plan.views).toHaveLength(1);
		for (const pair of fusion.pairs) {
			expect(plan.claimedIps).toContain(pair.firstIp);
			expect(plan.claimedIps).toContain(pair.finishIp);
		}
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it.each([
		["left[i]=left[i]*2+1", 1, 0],
		["output[i]=left[i]", 2, 0],
		["left[i+1]=left[i]*0.5", 1, 1],
	] as const)("admits a two-access numeric kernel: %s", (accesses, views, maximum) => {
		const image = compile(`for(let i=0;i<count;i++){${accesses};}return left;`);
		const native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions[0];
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing numeric storage region");
		expect(plan.views).toHaveLength(views);
		expect(Math.max(...plan.views.map((view) => view.maxOffset))).toBe(maximum);
		expect(plan.views.some((view) => view.writable)).toBe(true);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it.each(["i++", "i+=1", "i+=2", "i=i+4", "i=3+i", "i-= -2"])(
		"retains the proven positive stride for %s",
		(update) => {
			const image = compile(
				`for(let i=0;i<count;${update}){output[i]=left[i]+right[i];}return output;`,
			);
			const plan = image.native.functions[1]!.storage!.numericLoopRegions[0];
			if (plan?.kind !== "fixed-numeric") throw new Error("Missing strided region");
			expect(plan.stride).toBe(
				update === "i++" || update === "i+=1"
					? 1
					: update === "i=i+4"
						? 4
						: update === "i=3+i"
							? 3
							: 2,
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it.each([3, 4])(
		"admits an interleaved %i-lane body within the existing instruction budget",
		(lanes) => {
			const accesses = Array.from(
				{ length: lanes },
				(_, lane) => `output[i+${lane}]=left[i+${lane}]+right[i+${lane}];`,
			).join("");
			const image = compile(
				`for(let i=0;i<count;i+=${lanes}){${accesses}}return output;`,
			);
			const fn = image.native.functions[1]!;
			const plan = fn.storage!.numericLoopRegions[0];
			if (plan?.kind !== "fixed-numeric") throw new Error("Missing interleaved region");
			expect(plan.stride).toBe(lanes);
			expect(
				plan.views.every((view) => view.minOffset === 0 && view.maxOffset === lanes - 1),
			).toBe(true);
			expect(plan.claimedIps.length).toBeLessThanOrEqual(65);
			expect(emitCompiledFunction(fn, 1, "", false)).not.toBeNull();
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
	it("declines a fifth lane instead of multiplying the region budget", () => {
		const accesses = Array.from(
			{ length: 5 },
			(_, lane) => `output[i+${lane}]=left[i+${lane}]+right[i+${lane}];`,
		).join("");
		expect(
			compile(`for(let i=0;i<count;i+=5){${accesses}}`).native.functions[1]!.storage!
				.numericLoopRegions,
		).toEqual([]);
	});
	it("proves distinct affine windows while retaining ordered rounded readback", () => {
		const image = compile(
			"for(let i=1;i<count;i++){output[i-1]=left[i-1]+right[i+1];right[i]=output[i-1]-left[i];}return output;",
		);
		const native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing affine storage region");
		expect(plan.views).toEqual([
			{ object: 0, writable: false, minOffset: -1, maxOffset: 0 },
			{ object: 1, writable: true, minOffset: 0, maxOffset: 1 },
			{ object: 2, writable: true, minOffset: -1, maxOffset: -1 },
		]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it("rejects well-formed windows that omit a proven lower or upper access", () => {
		const image = compile(
			"for(let i=1;i<count;i++){output[i-1]=left[i-1]+right[i+1];right[i]=output[i-1]-left[i];}",
		);
		const native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing affine storage region");
		for (const views of [
			plan.views.with(0, { ...plan.views[0]!, minOffset: 0 }),
			plan.views.with(1, { ...plan.views[1]!, maxOffset: 0 }),
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, numericLoopRegions: [{ ...plan, views }] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});

	it.each([
		"for(let i=hook;i<count;i++){output[i-1]=left[i-1]+right[i+1];}",
		"for(let i=1;i<count;i++){let key;if(i&1)key=i+1;else key=1+i;output[i]=left[key]+right[i];}",
		"for(let i=1;i<count;i++){if(i&1)output[i-1]=left[i]+right[i+1];else output[i]=left[i-1]+right[i];}",
	])("retains affine facts within branches and unanimous joins: %s", (source) => {
		const image = compile(source);
		const [plan] = image.native.functions[1]!.storage!.numericLoopRegions;
		expect(plan?.kind).toBe("fixed-numeric");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("kills a hoisted constant overwritten by a memory result in the loop", () => {
		const image = compile("for(let i=0;i<count;i++){output[i+1]=left[i]+right[i];}");
		const native = image.native.functions[1]!;
		const constant = native.body.instructions.find(
			(op) => op.opcode === "CREATE_NUMBER" && op.value === 1,
		)!;
		if (constant.opcode !== "CREATE_NUMBER") throw new Error("Missing constant");
		const loadIp = native.body.instructions.findIndex(
			(op) => op.opcode === "LOAD_PROPERTY",
		);
		const load = native.body.instructions[loadIp]!;
		if (load.opcode !== "LOAD_PROPERTY") throw new Error("Missing load");
		const changed = {
			...native,
			body: {
				...native.body,
				instructions: native.body.instructions.with(loadIp, {
					...load,
					dst: constant.dst,
				}),
			},
		};
		expect(selectNativeFastPaths(changed).numericLoopRegions).toEqual([]);
	});
	it("requires the induction update to consume this iteration's increment", () => {
		const native = compile(
			"for(let i=0;i<count;i++){const key=i+1;output[key]=left[key]+right[key];}",
		).native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing storage region");
		const original = native.body.instructions;
		const firstMemory = original.findIndex((op) => op.opcode === "LOAD_PROPERTY");
		const load = original[firstMemory]!;
		if (load.opcode !== "LOAD_PROPERTY") throw new Error("Missing load");
		const keyIp = original.findIndex(
			(op) => op.opcode === "BINARY" && op.dst === load.key,
		);
		const incrementIp = original.findIndex(
			(op) => op.opcode === "UNARY" && op.operator === "increment",
		);
		const update: BytecodeInstruction = { opcode: "MOVE", dst: plan.index, src: 4 };
		for (const earlyUpdate of [false, true]) {
			const instructions: Array<BytecodeInstruction> = [
				...original.slice(0, keyIp),
				{ opcode: "MOVE", dst: load.key, src: plan.index },
				...(earlyUpdate ? [update] : []),
				...original.slice(firstMemory, incrementIp),
				{ opcode: "UNARY", operator: "increment", dst: 4, src: load.key },
				...(earlyUpdate ? [] : [update]),
				{ opcode: "JUMP", targetIp: plan.id },
			];
			const selected = selectNativeFastPaths({
				...native,
				registerRepresentations: native.registerRepresentations.with(4, "number"),
				body: { ...native.body, instructions },
				instructions: instructions.map(() => undefined),
				gc: {
					safepoints: [
						{ ...native.gc.safepoints.at(-1)!, instructionIp: instructions.length - 1 },
					],
				},
			}).numericLoopRegions;
			expect(selected.map((region) => region.kind)).toEqual(
				earlyUpdate ? [] : ["fixed-numeric"],
			);
		}
	});
	it("rejects a strided update that reads the previous iteration's arithmetic result", () => {
		const native = compile("for(let i=0;i<count;i+=2){output[i]=left[i]+right[i];}")
			.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions[0];
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing strided region");
		const original = native.body.instructions;
		const updateIp = original.findIndex(
			(op, ip) =>
				plan.claimedIps.includes(ip) && op.opcode === "MOVE" && op.dst === plan.index,
		);
		const update = original[updateIp]!;
		if (update.opcode !== "MOVE") throw new Error("Missing index update");
		const stepIp = original.findIndex(
			(op, ip) =>
				plan.claimedIps.includes(ip) && op.opcode === "BINARY" && op.dst === update.src,
		);
		const step = original[stepIp]!;
		const instructions = original.with(stepIp, update).with(updateIp, step);
		expect(
			selectNativeFastPaths({
				...native,
				body: { ...native.body, instructions },
				instructions: instructions.map(() => undefined),
			}).numericLoopRegions,
		).toEqual([]);
	});
	it("retains one range and three ordered view accesses through the artifact", () => {
		const image = compile(body),
			native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		expect(plan?.kind).toBe("fixed-numeric");
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing storage region");
		expect(plan.views.map((view) => view.writable)).toEqual([false, false, true]);
		expect(plan.carried).toContain(plan.index);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		const emitted = emitCompiledFunction(native, 1, "", false)!.source;
		expect(emitted.match(/mal_vm_fixed_numeric_storage\(/g)).toHaveLength(
			plan.views.length,
		);
		expect(emitted.match(/mal_vm_fixed_numeric_load\(/g)).toHaveLength(2);
		expect(emitted.match(/mal_vm_fixed_numeric_store\(/g)).toHaveLength(1);
	});
	it("dispatches once to a bounded Float64 specialization before the loop", () => {
		const native = compile(body).native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing storage region");
		const source = emitCompiledFunction(native, 1, "", false)!.source;
		const kindGuards = [...source.matchAll(/\.kind == MAL_TA_FLOAT64/g)];
		expect(kindGuards).toHaveLength(plan.views.length);
		expect(kindGuards.at(-1)!.index).toBeLessThan(source.indexOf("for (;;)"));
		expect(source.match(/for \(;;\)/g)).toHaveLength(2);
		expect(source.match(/mal_vm_fixed_numeric_storage\(/g)).toHaveLength(
			plan.views.length,
		);
		expect(
			source.match(
				/mal_scalar_f64_from_bits\(mal_scalar_load_native_u64\(__typed_loop_/g,
			),
		).toHaveLength(2);
		expect(source.match(/mal_scalar_store_native_u64\(__typed_loop_/g)).toHaveLength(1);
	});
	it("retains the store before a rounded or aliased readback", () => {
		const image = compile(
			"for(let i=0;i<count;i++){output[i]=left[i]+right[i];right[i]=output[i]-left[i];}return right;",
		);
		const native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing storage region");
		expect(plan.views.map((view) => view.writable)).toEqual([false, true, true]);
		const accesses = plan.claimedIps
			.map((ip) => native.body.instructions[ip]!)
			.filter((op) => op.opcode === "LOAD_PROPERTY" || op.opcode === "STORE_PROPERTY");
		expect(accesses.map((op) => op.opcode)).toEqual([
			"LOAD_PROPERTY",
			"LOAD_PROPERTY",
			"STORE_PROPERTY",
			"LOAD_PROPERTY",
			"LOAD_PROPERTY",
			"STORE_PROPERTY",
		]);
		expect(
			[
				...emitCompiledFunction(native, 1, "", false)!.source.matchAll(
					/mal_vm_fixed_numeric_(load|store)\(/g,
				),
			].map((match) => match[1]),
		).toEqual(["load", "load", "store", "load", "load", "store"]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});
	it.each([
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];hook();}",
		"for(let i=0;i<count;i++){let key;if(i&1)key=i+1;else key=i+2;output[key]=left[i]+right[i];}",
		"let key=0;for(let i=0;i<count;i++){output[key]=left[i]+right[i];key=i+2;}",
		"let offset=1;for(let i=0;i<count;i++){output[i+offset]=left[i]+right[i];offset=2;}",
		"let offset;if(hook)offset=1;else offset=2;for(let i=0;i<count;i++){output[i+offset]=left[i]+right[i];}",
		"for(let i=0;i<count;i++){let key=i+1;key=left[i];output[key]=left[i]+right[i];}",
		"for(let i=0;i<count;i++){output[i+0.5]=left[i]+right[i];}",
		"for(let i=0;i<count;i++){output[i+2147483648]=left[i]+right[i];}",

		"for(let i=0;i<count;i+=0){output[i]=left[i]+right[i];}",
		"for(let i=0;i<count;i-=2){output[i]=left[i]+right[i];}",
		"for(let i=0;i<count;i+=0.5){output[i]=left[i]+right[i];}",
		"for(let i=0;i<count;i+=2147483648){output[i]=left[i]+right[i];}",
		"for(let i=0;i<count;i+=hook){output[i]=left[i]+right[i];}",
		"let step=2;for(let i=0;i<count;i+=step){output[i]=left[i]+right[i];step=left[i];}",
		"let step;for(let i=0;i<count;i+=step){output[i]=left[i]+right[i];if(hook)step=2;else step=4;}",
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];left=right;}",
		"for(let i=0;i<count;){output[i]=left[i]+right[i];if(hook)i++;}",
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];count--;}",
		"for(let i=0;i<count;i++){output[i]=left[i]+right[i];output[i]=hook(i);}",
	])("declines an unproved interior: %s", (source) => {
		expect(
			compile(source).native.functions[1]!.storage!.numericLoopRegions.filter(
				(plan) => plan.kind === "fixed-numeric",
			),
		).toEqual([]);
	});
	it("recomputes forged bounds, ownership, and write requirements", () => {
		const image = compile(body),
			native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions[0]!;
		if (plan.kind !== "fixed-numeric") throw new Error("Missing storage region");
		for (const forged of [
			{ ...plan, stride: 0 },
			{ ...plan, stride: -1 },
			{ ...plan, stride: 2 },
			{ ...plan, stride: 0.5 },
			{ ...plan, stride: 2147483648 },
			{ ...plan, stride: undefined } as unknown as NativeNumericLoopRegionPlan,
			{ ...plan, bound: plan.index },
			{ ...plan, views: plan.views.slice(1) },
			{ ...plan, views: plan.views.map((view) => ({ ...view, writable: false })) },
			{ ...plan, kind: "integer" as const },
			{ ...plan, views: plan.views.map((view) => ({ ...view, minOffset: 1 })) },
			{ ...plan, views: plan.views.map((view) => ({ ...view, maxOffset: -1 })) },
			{
				...plan,
				views: plan.views.map(({ minOffset: _minimum, ...view }) => view),
			} as unknown as NativeNumericLoopRegionPlan,

			{ ...plan, carried: plan.carried.filter((register) => register !== plan.index) },
		])
			expect(() =>
				serializeCompilerArtifact({
					...image,
					native: {
						...image.native,
						functions: image.native.functions.with(1, {
							...native,
							storage: { ...native.storage!, numericLoopRegions: [forged] },
						}),
					},
				}),
			).toThrow(/invalid or stale storage plan/);
	});
});
