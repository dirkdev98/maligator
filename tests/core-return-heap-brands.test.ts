import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("normal return heap brands", () => {
	it("retains mutable constructor and method fallbacks", () => {
		const out = inspectStaticValueFunction(
			`const make=function make(hook){for(let i=0;i<3;i++)hook();return new Map();};
		function compute(hook,key){const value=make(hook);hook(value);return Map.prototype.has.call(value,key);}globalThis.compute=compute;`,
			"compute",
			{ realms: false, locked: false },
		);
		expect(out.core.some((op) => op.attributes.normalResultHeapBrand !== undefined)).toBe(
			false,
		);
		expect(
			out.core.some((op) => op.attributes.exactCollectionReceiver !== undefined),
		).toBe(false);
		expect(out.native.body.instructions.some((op) => op.opcode === "CALL")).toBe(true);
	});
	it.each([
		["Map", "flag ? new Map() : new Map()", "Map.prototype.has.call(value,key)"],
		["Set", "new Set()", "Set.prototype.has.call(value,key)"],
		["Map", "local", "Map.prototype.get.call(value,key)"],
		["Uint8Array", "new Uint8Array(4)", "value[key]"],
	] as const)(
		"carries %s through an effectful factory returning %s",
		(brand, result, use) => {
			const out = inspectStaticValueFunction(
				`const make=function make(hook,flag){let local=new Map();for(let i=0;i<3;i++){hook();if(flag)local=new Map();}return ${result};};
			function compute(hook,key,flag){const value=make(hook,flag);hook(value);return ${use};}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			expect(
				out.core.some(
					(op) => op.opcode === "call" && op.attributes.normalResultHeapBrand === brand,
				),
			).toBe(true);
			if (brand === "Uint8Array") {
				expect(out.core.some((op) => op.attributes.exactTypedArrayKind === brand)).toBe(
					true,
				);
				expect(
					out.core.some((op) => op.attributes.containedFixedTypedArrayKind !== undefined),
				).toBe(false);
			} else
				expect(
					out.core.some((op) => op.attributes.exactCollectionReceiver === brand),
				).toBe(true);
			expect(
				out.native.body.instructions.filter((op) => op.opcode === "CALL").length,
			).toBeGreaterThanOrEqual(2);
		},
	);

	it("joins multiple complete callees and chains their normal brands", () => {
		const out = inspectStaticValueFunction(
			`const first=function first(hook){for(let i=0;i<3;i++)hook();return new Map();};
			const second=function second(hook){for(let i=0;i<3;i++)hook();return new Map();};
			const outer=function outer(hook,flag){for(let i=0;i<3;i++)hook();const make=flag?first:second;return make(hook);};
			function compute(hook,key,flag){const value=outer(hook,flag);hook(value);return Map.prototype.has.call(value,key);}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		expect(out.core.some((op) => op.attributes.normalResultHeapBrand === "Map")).toBe(
			true,
		);
		expect(out.core.some((op) => op.attributes.exactCollectionReceiver === "Map")).toBe(
			true,
		);
	});
	it("converges recursive calls with a normal Map return", () => {
		const out = inspectStaticValueFunction(
			`const make=function make(hook,count){hook();if(count>0)return make(hook,count-1);return new Map();};
		function compute(hook,key,count){const value=make(hook,count);hook(value);return Map.prototype.has.call(value,key);}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		expect(out.core.some((op) => op.attributes.normalResultHeapBrand === "Map")).toBe(
			true,
		);
		expect(out.core.some((op) => op.attributes.exactCollectionReceiver === "Map")).toBe(
			true,
		);
	});
	it("keeps a spread call's effects while publishing its normal brand", () => {
		const out = inspectStaticValueFunction(
			`const make=function make(hook){for(let i=0;i<3;i++)hook();return new Map();};
		function compute(args,hook,key){const value=make(...args);hook(value);return Map.prototype.has.call(value,key);}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		expect(
			out.core.some(
				(op) =>
					(op.opcode === "callSpread" || op.opcode === "callSpreadIterable") &&
					op.attributes.normalResultHeapBrand === "Map",
			),
		).toBe(true);
		expect(out.core.some((op) => op.attributes.exactCollectionReceiver === "Map")).toBe(
			true,
		);
	});

	it("folds IsArray after compatible Array returns while keeping factory and callback effects", () => {
		const out = inspectStaticValueFunction(
			`const make=function make(hook,flag){for(let i=0;i<3;i++)hook();return flag?[]:[];};
			function compute(hook,flag){const value=make(hook,flag);hook(value);return Array.isArray(value);}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		expect(out.core.some((op) => op.attributes.normalResultHeapBrand === "Array")).toBe(
			true,
		);
		expect(out.core.some((op) => op.attributes.operation === "Array.isArray")).toBe(
			false,
		);
		expect(
			out.native.body.instructions.filter((op) => op.opcode === "CALL"),
		).toHaveLength(2);
	});

	it.each([
		["function", "flag ? new Map() : new Set()"],
		["function", "new Proxy(new Map(),{})"],
		["function", "flag ? new Map() : undefined"],
		["async function", "new Map()"],
		["function*", "new Map()"],
	] as const)("preserves the fallback for %s returning %s", (kind, result) => {
		const out = inspectStaticValueFunction(
			`const make=${kind} make(hook,flag){for(let i=0;i<3;i++)hook();return ${result};};
			function compute(hook,key,flag){const value=make(hook,flag);hook(value);return Map.prototype.has.call(value,key);}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		expect(out.core.some((op) => op.attributes.normalResultHeapBrand !== undefined)).toBe(
			false,
		);
		expect(
			out.core.some((op) => op.attributes.exactCollectionReceiver !== undefined),
		).toBe(false);
	});

	it.each([false, true])(
		"accounts for constructor receiver substitution with primitive branch=%s",
		(primitive) => {
			const out = inspectStaticValueFunction(
				`const Make=function Make(hook,flag){for(let i=0;i<3;i++)hook();return ${primitive ? "flag ? new Map() : 7" : "new Map()"};};
			function compute(hook,key,flag){const value=new Make(hook,flag);hook(value);return Map.prototype.has.call(value,key);}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			expect(
				out.core.some(
					(op) =>
						op.opcode === "construct" && op.attributes.normalResultHeapBrand === "Map",
				),
			).toBe(!primitive);
			expect(out.core.some((op) => op.attributes.exactCollectionReceiver === "Map")).toBe(
				!primitive,
			);
		},
	);
});
