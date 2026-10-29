import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	createNativeFunctionRenderer,
	directCompiledEntryKey,
	emitCompiledFunction,
} from "../src/compiler/target/render-native-c.ts";
import { positionTableEntries } from "../src/compiler/target/runtime-image.ts";
import { TEST_RELOCATION } from "./helpers/native-relocation.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const cases = [
	[
		"typed String fusion",
		`function compute(left,right){return (left+right)*3;}
		globalThis.compute=compute;
		globalThis.result=compute(String(globalThis.left),String(globalThis.right));`,
		"numeric-fusion",
	],
	[
		"polling numeric worker",
		`function compute(value,count){for(let index=0;index<count;index++)value=(value+1)*3;return value;}
		globalThis.compute=compute;globalThis.result=compute(3,7);`,
		"numeric-fusion",
	],
	[
		"overlapping iterator overlays",
		`function compute(values){let total=0;for(const value of values)total+=value;return total;}
		globalThis.compute=compute;`,
		"iterator-result-virtualization",
	],
	[
		"split projections",
		`function compute(value){const fields=value.split(';');return fields[1]+fields[0]+fields.length;}
		globalThis.compute=compute;`,
		"string-split-projection",
	],
	[
		"RegExp projections",
		`function compute(regexp,value){const match=regexp.exec(value);if(match===null)return -1;return Number(match[1]);}
		globalThis.compute=compute;`,
		"regexp-exec-projection",
	],
] as const;

describe("native rendering analysis lifetime", () => {
	it("reports unavailable fast callees so later availability can reopen admission", () => {
		const image = compileEntrypoint(
			new URL("./local/frameless-forward-call.js", import.meta.url).pathname,
			{
				buildConfig: resolveBuildConfig({
					engine: { primordials: "locked", eval: false, realms: false },
				}),
				coreOptimizationBenchmarkAblation: { family: "inlining-cross-call" },
			},
		);
		const native = image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "caller",
		)!;
		const target = native.instructions.find((plan) => plan?.kind === "call");
		expect(target?.kind).toBe("call");
		if (target?.kind !== "call" || target.directFunctionIndex === undefined)
			throw new Error("Missing direct callee");
		const callee = target.directFunctionIndex;
		const lookups = new Set<string>();
		const render = createNativeFunctionRenderer((caller, target) =>
			lookups.add(`${caller}:${target}`),
		);
		const args: Parameters<typeof emitCompiledFunction> = [
			native,
			native.functionIndex,
			"",
			false,
			"static",
			new Set([callee]),
			[],
			new Map(),
			false,
			new Set(),
			image.runtime.stringConstants,
		];
		for (const available of [false, true, false]) {
			args[16] = available ? new Map([[callee, undefined]]) : new Map();
			lookups.clear();
			const emitted = render(...args);
			expect(lookups).toEqual(new Set([`${native.functionIndex}:${callee}`]));
			expect(emitted?.trySymbol !== undefined).toBe(available);
		}
	});

	it.each(cases)(
		"preserves fresh-render output across repeated %s emissions",
		(name, source, regionKind) => {
			const { native, image } = inspectStaticValueFunction(source, "compute");
			expect(native.specializations.some((region) => region.kind === regionKind)).toBe(
				true,
			);
			if (name === "polling numeric worker")
				expect(
					native.directEntries.some(
						(entry) => (entry.storage!.numericWorker?.pollingIps.length ?? 0) > 0,
					),
				).toBe(true);
			const render = createNativeFunctionRenderer();
			const targets = new Set(image.native.functions.map((fn) => fn.functionIndex));
			const entries = new Map(
				image.native.functions.flatMap((fn) =>
					fn.directEntries.map(
						(entry) =>
							[directCompiledEntryKey(fn.functionIndex, entry.id), entry] as const,
					),
				),
			);
			for (const [suffix, debug, available, relocatable] of [
				["", false, false, false],
				["_observed", true, true, false],
				["_relocated", true, false, true],
				["", false, true, false],
			] as const) {
				const args: Parameters<typeof emitCompiledFunction> = [
					native,
					native.functionIndex,
					suffix,
					debug
						? positionTableEntries(image.runtime.functions[native.functionIndex]!)
						: false,
					"static",
					available ? targets : new Set(),
					image.native.semanticProtectors,
					available ? entries : new Map(),
					relocatable ? TEST_RELOCATION : false,
					targets,
					image.runtime.stringConstants,
				];
				expect(render(...args)).toEqual(emitCompiledFunction(...args));
			}
		},
	);

	it("revalidates replaced action and region identities on the same body", () => {
		const { native } = inspectStaticValueFunction(cases[0][1], "compute");
		const render = createNativeFunctionRenderer();
		expect(render(native, native.functionIndex, "", false)).not.toBeNull();
		for (const changed of [
			{ ...native, regionActions: native.regionActions.slice(1) },
			{ ...native, specializations: [] },
		])
			expect(() => render(changed, native.functionIndex, "", false)).toThrow(
				/stale region actions/,
			);
		expect(render(native, native.functionIndex, "", false)).toEqual(
			emitCompiledFunction(native, native.functionIndex, "", false),
		);
	});

	it("rechecks in-place image mutations in a fresh emission", () => {
		const { native } = inspectStaticValueFunction(cases[0][1], "compute");
		const actions = [...native.regionActions];
		const changed = { ...native, regionActions: actions };
		expect(
			createNativeFunctionRenderer()(changed, native.functionIndex, "", false),
		).not.toBeNull();
		actions.pop();
		expect(() =>
			createNativeFunctionRenderer()(changed, native.functionIndex, "", false),
		).toThrow(/stale region actions/);
		expect(() => emitCompiledFunction(changed, native.functionIndex, "", false)).toThrow(
			/stale region actions/,
		);
	});
});
