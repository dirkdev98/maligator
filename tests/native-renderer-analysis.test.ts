import { describe, expect, it } from "vitest";
import {
	createNativeFunctionRenderer,
	directCompiledEntryKey,
	emitCompiledFunction,
} from "../src/compiler/target/render-native-c.ts";
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
					debug,
					"static",
					available ? targets : new Set(),
					image.native.semanticProtectors,
					available ? entries : new Map(),
					relocatable,
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
