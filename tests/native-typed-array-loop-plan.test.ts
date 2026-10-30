import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { analyzeNativeFastPaths } from "../src/compiler/target/lower-native-fast-paths.ts";
import type { NativeNumericLoopRegionPlan } from "../src/compiler/target/lower-native-fast-paths.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";
import {
	decodeVmValueOperand,
	VM_MATH_UNARY_NUMBER_OPERATIONS,
} from "../src/compiler/target/runtime-image.ts";

function compile(
	body: string,
	parameters = "left,right,output,count,hook",
	primordials: "mutable" | "locked" = "mutable",
) {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel=function(${parameters}){${body}};`,
			"/typed-loop.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
		},
	);
}
const body = "for(let i=0;i<count;i++){output[i]=left[i]+right[i];}return output;";
describe("fixed TypedArray loop storage", () => {
	it.each([64, 65])("bounds variadic numeric calls at %i arguments", (arity) => {
		const arguments_ = Array.from({ length: arity }, () => "value").join(",");
		const image = compile(
			`for(let i=0;i<count;i++){const value=left[i];output[i]=Math.hypot(${arguments_});}return output;`,
			undefined,
			"locked",
		);
		const native = image.native.functions[1]!;
		expect(native.storage!.numericLoopRegions.map((plan) => plan.kind)).toEqual(
			arity === 64 ? ["fixed-numeric"] : [],
		);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
		expect(
			serializeCompilerArtifact(
				deserializeCompilerArtifact(serializeCompilerArtifact(image)),
			),
		).toEqual(serializeCompilerArtifact(image));
	});
	it.each(VM_MATH_UNARY_NUMBER_OPERATIONS)(
		"carries numeric storage across the certified %s body",
		(operation) => {
			const image = compile(
				`for(let i=0;i<count;i++)output[i]=${operation}(left[i]);return output;`,
				undefined,
				"locked",
			);
			const native = image.native.functions[1]!;
			const [plan] = native.storage!.numericLoopRegions;
			expect(plan?.kind).toBe("fixed-numeric");
			expect(
				plan!.claimedIps.some(
					(ip) => native.body.instructions[ip]!.opcode === "CALL_KNOWN",
				),
			).toBe(true);
			expect(
				serializeCompilerArtifact(
					deserializeCompilerArtifact(serializeCompilerArtifact(image)),
				),
			).toEqual(serializeCompilerArtifact(image));
			expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
		},
	);
	it.each([
		"Math.sqrt(+left[i])",
		"Math.min(+left[i],+right[i])",
		"Math.max(left[i],right[i])",
		"Math.min(left[i],3)",
		"Math.abs(left[i],hook)",
		"Math.clz32(left[i])",
		"Math.f16round(left[i])",
		"Math.imul(left[i],right[i])",
		"Math.pow(left[i],right[i])",
		"Math.atan2(left[i],right[i])",
		"Math.hypot(left[i],right[i])",
		"Math.hypot(left[i],right[i],3)",
		"Math.min(left[i],right[i],3)",
		"Math.max(left[i],right[i],3,hook)",
		"Math.min(left[i])",
		"Math.imul(left[i])",
		"Math.pow(left[i],undefined)",
		"Math.min(left[i],null,true)",
		"Math.imul(left[i],true,hook)",
		"Math.clz32(left[i],hook)",
	])(
		"retains primitive Math operations, literals and ignored operands: %s",
		(expression) => {
			const image = compile(
				`for(let i=0;i<count;i++)output[i]=${expression};return output;`,
				undefined,
				"locked",
			);
			const native = image.native.functions[1]!;
			expect(native.storage!.numericLoopRegions[0]?.kind).toBe("fixed-numeric");
			expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
		},
	);
	it.each(["Math.abs(left[i])", "Math.min(left[i],right[i])", "hook(left[i])"])(
		"retains mutable callee lookup and effects outside storage: %s",
		(expression) => {
			expect(
				compile(`for(let i=0;i<count;i++)output[i]=${expression};`).native.functions[1]!
					.storage!.numericLoopRegions,
			).toEqual([]);
		},
	);
	it.each([
		"Math.abs(left[i],hook())",
		"new Math.abs(left[i])",
		"Math.abs(...left)",
		"Math.min(left[i],hook)",
	])("does not erase possible effects or nonnumeric operands: %s", (expression) => {
		const image = compile(
			`for(let i=0;i<count;i++)output[i]=${expression};`,
			"left,right,output,count,hook",
			"locked",
		);
		if (expression === "Math.min(left[i],hook)") {
			const native = image.native.functions[1]!;
			const plan = native.storage!.numericLoopRegions[0];
			expect(plan?.kind).toBe("fixed-numeric");
			const call = native.body.instructions.find(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === "Math.min",
			);
			if (call?.opcode !== "CALL_KNOWN") throw new Error("Missing numeric builtin call");
			const input = decodeVmValueOperand(call.arguments[1]!);
			if (input.kind !== "register") throw new Error("Missing dynamic numeric input");
			expect(plan!.inputs).toContain(input.register);
		} else expect(image.native.functions[1]!.storage!.numericLoopRegions).toEqual([]);
	});
	it.each([
		["let total=0;for(let i=0;i<count;i++)total+=left[i];return total;", 1],
		["let total=0;for(let i=0;i<count;i++)total+=left[i]*right[i];return total;", 2],
		["let total=0;for(let i=count-1;i>=0;i--)total+=left[i];return total;", 1],
	] as const)("retains read-only storage for a numeric reduction: %s", (body, views) => {
		const image = compile(body);
		const native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions.find(
			(plan) => plan.kind === "fixed-numeric",
		);
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing reduction storage");
		expect(plan.views).toHaveLength(views);
		expect(plan.views.every((view) => !view.writable)).toBe(true);
		expect(plan.exits.some((exit) => exit.outputs.length > 0)).toBe(true);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it("checks a read whose key is not the loop index against its view", () => {
		const image = compile(
			"let total=0;for(let i=0;i<count;i++)total+=left[i&7];return total;",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions.find(
			(plan) => plan.kind === "fixed-numeric",
		);
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing checked lookup storage");
		expect(plan.views).toEqual([
			expect.objectContaining({ writable: false, checked: true }),
		]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it("declines a store whose key is not the loop index", () => {
		const image = compile("for(let i=0;i<count;i++)output[i&7]=left[i];return output;");
		expect(
			image.native.functions[1]!.storage!.numericLoopRegions.filter(
				(plan) => plan.kind === "fixed-numeric",
			),
		).toEqual([]);
	});
	it("retains all eight owners for a seven-input numeric kernel", () => {
		const image = compile(
			"for(let i=0;i<count;i++)output[i]=left[i]+right[i]+a[i]+b[i]+c[i]+d[i]+e[i];return output;",
			"left,right,a,b,c,d,e,output,count",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions.find(
			(plan) => plan.kind === "fixed-numeric",
		);
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing multi-owner storage");
		expect(plan.views).toHaveLength(8);
		expect(plan.views.filter((view) => view.writable)).toHaveLength(1);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it("retains eight interleaved lanes and their complete ordered windows", () => {
		const image = compile(
			`for(let i=0;i<count;i+=8){${Array.from({ length: 8 }, (_, index) => `output[i+${index}]=left[i+${index}]+right[i+${index}]+hook[i+${index}];`).join("")}}return output;`,
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions.find(
			(plan) => plan.kind === "fixed-numeric",
		);
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing interleaved storage");
		expect(plan.counter?.stride).toBe(8);
		expect(plan.views).toHaveLength(4);
		expect(plan.views.every((view) => view.minOffset === 0 && view.maxOffset === 7)).toBe(
			true,
		);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
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
			expect(plan.counter?.stride).toBe(
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
			expect(plan.counter?.stride).toBe(lanes);
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
	it.each([
		["i>=0", "i--", -1],
		["i>0", "i-=1", -1],
		["i>=0", "i=i-3", -3],
		["i>0", "i+=-4", -4],
		["i>=0", "i-=2147483647", -2147483647],
		["i<=count", "i++", 1],
		["i<=count", "i+=3", 3],
		["0<=i", "i--", -1],
		["0<i", "i-=3", -3],
		["count>=i", "i++", 1],
		["count>i", "i+=3", 3],
	] as const)("retains the direction of %s with %s", (condition, update, stride) => {
		const image = compile(
			`for(let i=hook;${condition};${update}){output[i]=left[i]+right[i];}return output;`,
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions[0];
		if (plan?.kind !== "fixed-numeric")
			throw new Error("Missing directed storage region");
		expect(plan.counter?.stride).toBe(stride);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it("retains negative affine windows in a descending interleaved region", () => {
		const image = compile(
			"for(let i=count;i>0;i-=3){output[i-1]=left[i-1];output[i-2]=left[i-2];output[i-3]=left[i-3];}return output;",
		);
		const native = image.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions[0];
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing descending region");
		expect(plan.counter?.stride).toBe(-3);
		expect(
			plan.views.every((view) => view.minOffset === -3 && view.maxOffset === -1),
		).toBe(true);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});
	it("declines a kernel beyond the bounded access budget", () => {
		const accesses = Array.from(
			{ length: 11 },
			(_, lane) => `output[i+${lane}]=left[i+${lane}]+right[i+${lane}];`,
		).join("");
		expect(
			compile(`for(let i=0;i<count;i+=11){${accesses}}`).native.functions[1]!.storage!
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

	it("replaces contained TypedArray accesses with region views", () => {
		const image = compile(
			"const scratch=new Float64Array(64);for(let i=0;i<scratch.length;i++)scratch[i]=left[i]*2;let sum=0;for(let i=0;i<scratch.length;i++)sum+=scratch[i];return sum;",
			undefined,
			"locked",
		);
		const native = image.native.functions[1]!;
		const contained = native.body.instructions.flatMap((_, ip) =>
			native.instructions[ip]?.kind === "contained-fixed-typed-array-element" ? [ip] : [],
		);
		const claimed = new Set(
			native.storage!.numericLoopRegions.flatMap((plan) =>
				plan.kind === "fixed-numeric" ? plan.claimedIps : [],
			),
		);
		expect(contained).not.toEqual([]);
		expect(contained.filter((ip) => !claimed.has(ip))).toEqual([]);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("consumes per-access element kinds inside mixed storage regions", () => {
		const image = compile(
			"const values=new Uint32Array(64);const weights=new Float32Array(64);for(let i=0;i<values.length;i++){values[i]=i*7919.5;weights[i]=values[i]*0.25;}let sum=0;for(let i=0;i<values.length;i++)sum+=values[i]+weights[i];return sum;",
			undefined,
			"locked",
		);
		const native = image.native.functions[1]!;
		const claimed = new Set(
			native.storage!.numericLoopRegions.flatMap((plan) =>
				plan.kind === "fixed-numeric" ? plan.claimedIps : [],
			),
		);
		const kinds = new Set(
			[...claimed].flatMap((ip) => {
				const access = native.instructions[ip];
				return access?.kind === "exact-typed-array-element" ||
					access?.kind === "contained-fixed-typed-array-element"
					? [access.elementKind]
					: [];
			}),
		);
		expect(kinds).toEqual(new Set(["Uint32Array", "Float32Array"]));
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		for (const plan of [native, restored.native.functions[1]!]) {
			const emitted = emitCompiledFunction(plan, 1, "", false);
			expect(emitted).not.toBeNull();
			expect(emitted!.source).not.toContain("mal_vm_fixed_numeric_load(");
			expect(emitted!.source).not.toContain("mal_vm_fixed_numeric_store(");
		}
	});

	const dataViewKernel =
		"for(let i=0;i<left.length;i++){output.setUint32(i*4+1,left[i],(i&1)===0);}return output;";
	const dataViewRegions = (source: string) =>
		compile(
			source,
			undefined,
			"locked",
		).native.functions[1]!.storage!.numericLoopRegions.filter(
			(plan) =>
				plan.kind === "fixed-numeric" &&
				plan.views.some((view) => view.byteScale !== undefined),
		);

	it("addresses DataView accessor calls at scaled byte windows", () => {
		const image = compile(dataViewKernel, undefined, "locked");
		const native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing fixed-numeric region");
		const call = native.body.instructions.findIndex((op) => op.opcode === "CALL");
		expect(plan.dataViewCalls).toEqual([{ ip: call, set: true, type: "Uint32" }]);
		expect(plan.views.find((view) => view.byteScale !== undefined)).toMatchObject({
			byteScale: 4,
			minOffset: 1,
			maxOffset: 4,
			writable: true,
		});
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
	});

	it("rejects a stored DataView window or accessor that planning did not prove", () => {
		const image = compile(dataViewKernel, undefined, "locked");
		const native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing fixed-numeric region");
		const data = plan.views.findIndex((view) => view.byteScale !== undefined);
		for (const forged of [
			{ ...plan, views: plan.views.with(data, { ...plan.views[data]!, byteScale: 1 }) },
			{
				...plan,
				dataViewCalls: [{ ...plan.dataViewCalls![0]!, type: "Uint8" as const }],
			},
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

	it("declines a DataView key that no counted window bounds", () => {
		expect(
			dataViewRegions(
				"for(let i=0;i<left.length;i++){output.setUint32(left[i],i);}return output;",
			),
		).toEqual([]);
	});

	it("declines a DataView as the loop's length bound", () => {
		const image = compile(
			"for(let i=0;i<output.length;i++){output.setUint8(i,i);}return output;",
			undefined,
			"locked",
		);
		const native = image.native.functions[1]!;
		expect(native.storage!.numericLoopRegions).toEqual([]);
		expect(emitCompiledFunction(native, 1, "", false)).not.toBeNull();
	});

	it("proves a byte stride hoisted past an enclosing loop", () => {
		expect(
			dataViewRegions(
				"for(let r=0;r<count;r++){for(let i=0;i<left.length;i++){output.setUint32(i*4+1,left[i],true);}}return output;",
			),
		).toHaveLength(1);
	});

	it("declines a byte stride that another path reassigns", () => {
		expect(
			dataViewRegions(
				"let stride=4;if(hook)stride=8;for(let i=0;i<left.length;i++){output.setUint32(i*stride,left[i]);}return output;",
			),
		).toEqual([]);
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
		expect(analyzeNativeFastPaths(changed).plans.numericLoopRegions).toEqual([]);
	});
	it("requires the induction update to consume this iteration's increment", () => {
		const native = compile(
			"for(let i=0;i<count;i++){const key=i+1;output[key]=left[key]+right[key];}",
		).native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		if (plan?.kind !== "fixed-numeric" || plan.counter === undefined)
			throw new Error("Missing storage region");
		const { index } = plan.counter;
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
		const update: BytecodeInstruction = { opcode: "MOVE", dst: index, src: 4 };
		for (const earlyUpdate of [false, true]) {
			const instructions: Array<BytecodeInstruction> = [
				...original.slice(0, keyIp),
				{ opcode: "MOVE", dst: load.key, src: index },
				...(earlyUpdate ? [update] : []),
				...original.slice(firstMemory, incrementIp),
				{ opcode: "UNARY", operator: "increment", dst: 4, src: load.key },
				...(earlyUpdate ? [] : [update]),
				{ opcode: "JUMP", targetIp: plan.id },
			];
			const selected = analyzeNativeFastPaths({
				...native,
				registerRepresentations: native.registerRepresentations.with(4, "number"),
				body: { ...native.body, instructions },
				instructions: instructions.map(() => undefined),
				gc: {
					safepoints: [
						{ ...native.gc.safepoints.at(-1)!, instructionIp: instructions.length - 1 },
					],
				},
			}).plans.numericLoopRegions;
			expect(selected.map((region) => region.kind)).toEqual(
				earlyUpdate ? [] : ["fixed-numeric"],
			);
		}
	});
	it("rejects a strided update that reads the previous iteration's arithmetic result", () => {
		const native = compile("for(let i=0;i<count;i+=2){output[i]=left[i]+right[i];}")
			.native.functions[1]!;
		const plan = native.storage!.numericLoopRegions[0];
		if (plan?.kind !== "fixed-numeric" || plan.counter === undefined)
			throw new Error("Missing strided region");
		const { index } = plan.counter;
		const original = native.body.instructions;
		const updateIp = original.findIndex(
			(op, ip) =>
				plan.claimedIps.includes(ip) && op.opcode === "MOVE" && op.dst === index,
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
			analyzeNativeFastPaths({
				...native,
				body: { ...native.body, instructions },
				instructions: instructions.map(() => undefined),
			}).plans.numericLoopRegions,
		).toEqual([]);
	});
	it("retains one range and three ordered view accesses through the artifact", () => {
		const image = compile(body),
			native = image.native.functions[1]!;
		const [plan] = native.storage!.numericLoopRegions;
		expect(plan?.kind).toBe("fixed-numeric");
		if (plan?.kind !== "fixed-numeric") throw new Error("Missing storage region");
		expect(plan.views.map((view) => view.writable)).toEqual([false, false, true]);
		expect(plan.carried).toContain(plan.counter?.index);
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
		"for(let i=count;i>=0;i++){output[i]=left[i]+right[i];}",
		"for(let i=count;i>0;i+=2){output[i]=left[i]+right[i];}",
		"for(let i=0;i<=count;i--){output[i]=left[i]+right[i];}",
		"for(let i=0;count<=i;i++){output[i]=left[i]+right[i];}",
		"for(let i=count;0>i;i--){output[i]=left[i]+right[i];}",
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
		if (plan.kind !== "fixed-numeric" || plan.counter === undefined)
			throw new Error("Missing storage region");
		const { counter } = plan;
		for (const forged of [
			{ ...plan, counter: { ...counter, stride: 0 } },
			{ ...plan, counter: { ...counter, stride: -1 } },
			{ ...plan, counter: { ...counter, stride: 2 } },
			{ ...plan, counter: { ...counter, stride: 0.5 } },
			{ ...plan, counter: { ...counter, stride: 2147483648 } },
			{
				...plan,
				counter: { ...counter, stride: undefined },
			} as unknown as NativeNumericLoopRegionPlan,
			{ ...plan, counter: { ...counter, bound: counter.index } },
			{ ...plan, counter: { ...counter, limitOffset: -1 } },
			{ ...plan, counter: undefined },
			{ ...plan, views: plan.views.slice(1) },
			{ ...plan, views: plan.views.map((view) => ({ ...view, writable: false })) },
			{ ...plan, kind: "integer" as const },
			{ ...plan, views: plan.views.map((view) => ({ ...view, minOffset: 1 })) },
			{ ...plan, views: plan.views.map((view) => ({ ...view, maxOffset: -1 })) },
			{
				...plan,
				views: plan.views.map(({ minOffset: _minimum, ...view }) => view),
			} as unknown as NativeNumericLoopRegionPlan,

			{ ...plan, carried: plan.carried.filter((register) => register !== counter.index) },
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
