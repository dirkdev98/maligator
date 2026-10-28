import { describe, expect, it } from "vitest";
import { CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import {
	instructionResultIntegerRange,
	instructionInputIntegerRange,
	INSTRUCTION_CALLS_USER_CODE,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
} from "../src/compiler/shared/integer-range.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const bounded = (minimum: number, maximum: number) => ({
	...COMPILER_INT32_RANGE,
	minimum,
	maximum,
});
function inspect(
	expression: string,
	options: {
		reader?: string;
		call?: string;
		declaration?: string;
		locked?: boolean;
	} = {},
) {
	return inspectStaticValueFunction(
		`const make=function make(value,hook){try{hook();return {n:${expression},tag:7};}catch(error){throw error;}};${options.declaration ?? "function"} compute(value,hook){const record=${options.call ?? "make(value,hook)"};${options.reader ?? "hook();return record.n%10;"}}globalThis.compute=compute;globalThis.make=make;`,
		"compute",
		{ locked: options.locked },
	);
}
function field(out: ReturnType<typeof inspect>) {
	const ip = out.native.body.instructions.findIndex(
		(op, ip) =>
			op.opcode.startsWith("LOAD_PROPERTY") &&
			out.native.facts?.[ip]?.resultIntegerRanges?.[0] !== undefined,
	);
	const op = out.native.body.instructions[ip]!;
	if (ip < 0 || !("dst" in op)) throw new Error("Missing bounded own-field read");
	return { op, facts: out.native.facts![ip]! };
}

describe("normal record field integer ranges", () => {
	it.each(["function", "function*", "async function", "async function*"])(
		"carries correlated writer payload ranges through %s lowering",
		(declaration) => {
			const suspension =
				(declaration.includes("*") ? "yield 0;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspectStaticValueFunction(
				`const make=function make(hook){for(let i=0;i<3;i++)hook();return {n:1};};${declaration} compute(flag,payload,input,hook){const n=input>>>0;const left=make(hook);const right=make(hook);let selected,other,value;if(flag){selected=left;other=right;value=payload;}else{if(n>=16)throw 0;selected=right;other=right;value=n;}${suspension}other.n=value;return selected.n%16;}globalThis.compute=compute;`,
				"compute",
				{ locked: false, realms: true },
			);
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 15));
			expect(
				out.native.body.instructions.some(
					(op) => op.opcode === "BINARY" && op.operator === "%",
				),
			).toBe(false);
		},
	);
	it.each(
		["literal", "producer-write", "caller-write"].flatMap((mode) =>
			(
				[
					["function", "n<middle", "middle<16", "n", 14],
					["function", "n<middle", "middle<bound&&bound<16", "n", 13],
					["function", "n<=middle", "middle<=n&&middle<16", "n", 15],
					["function", "n<middle", "middle<16", "n+1", 15],
					["function*", "n<middle", "middle<16", "n", 14],
					["async function", "n<middle", "middle<16", "n", 14],
					["async function*", "n<middle", "middle<16", "n", 14],
				] as const
			).map(([declaration, first, later, payload, maximum]) => ({
				mode,
				declaration,
				first,
				later,
				payload,
				maximum,
			})),
		),
	)(
		"carries transitive $mode bounds through $declaration ($first, $later, $payload)",
		({ mode, declaration, first, later, payload, maximum }) => {
			const values = "const n=value>>>0;const middle=limit>>>0;const bound=other&255;";
			const suspension =
				(declaration.includes("*") ? "yield 0;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const produce =
				mode === "literal"
					? `${values}if(${first}&&${later})return {n:${payload}};return {n:0};`
					: mode === "producer-write"
						? `${values}const record={n:0};if(${first}&&${later})record.n=${payload};hook();return record;`
						: "return {n:0};";
			const read =
				mode === "caller-write"
					? `${values}if(${first}){${suspension}if(${later})record.n=${payload};}`
					: suspension;
			const out = inspectStaticValueFunction(
				`const make=function make(value,limit,other,hook){for(let i=0;i<3;i++)hook(i);${produce}};${declaration} compute(value,limit,other,hook){const record=make(value,limit,other,hook);${read}hook();return record.n%16;}globalThis.make=make;globalThis.compute=compute;`,
				"compute",
				{ locked: false, realms: true },
			);
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, maximum));
			expect(out.native.registerRepresentations[op.dst]).toBe("int32");
			expect(
				out.native.body.instructions.some(
					(op) => op.opcode === "BINARY" && op.operator === "%",
				),
			).toBe(false);
		},
	);
	it("retains a wide earlier callback operand before a later field guard", () => {
		const out = inspectStaticValueFunction(
			`function make(value,limit,hook){const n=value>>>0;const bound=limit>>>0;if(n<bound){hook(n);if(bound<16)return {n};}return {n:0};}globalThis.make=make;`,
			"make",
			{ locked: false, realms: true },
		);
		const arguments_ = out.native.body.instructions.flatMap((op, ip) =>
			op.opcode === "CALL" && op.arguments.length === 1
				? [instructionInputIntegerRange(out.native.facts?.[ip], op.arguments[0]!)]
				: [],
		);
		expect(arguments_).toContainEqual(bounded(0, 0xffff_fffe));
	});
	it.each(
		["literal", "producer-write", "caller-write"].flatMap((mode) =>
			["limit&255", "boundedLimit(limit,hook)", "limits(limit,hook).n"].map((bound) => [
				mode,
				bound,
			]),
		),
	)("carries %s fields bounded by %s through the record result ABI", (mode, bound) => {
		const branch = `const n=value>>>0;const bound=${bound};`;
		const producer =
			mode === "literal"
				? `${branch}if(n<bound){hook();return {n};}hook();return {n:0};`
				: mode === "producer-write"
					? `${branch}const record={n:0};if(n<bound)record.n=n;hook();return record;`
					: "return {n:0};";
		const reader =
			mode === "caller-write"
				? `${branch}if(n<bound)record.n=n;hook();return record.n|0;`
				: "hook();return record.n|0;";
		const out = inspectStaticValueFunction(
			`const boundedLimit=function boundedLimit(value,hook){try{hook();return value&255;}catch(error){throw error;}};const limits=function limits(value,hook){try{hook();return {n:value&255};}catch(error){throw error;}};const make=function make(value,limit,hook){for(let i=0;i<3;i++)hook(i);${producer}};function compute(value,limit,hook){const record=make(value,limit,hook);${reader}}globalThis.make=make;globalThis.compute=compute;`,
			"compute",
			{ locked: false, realms: true },
		);
		const fields = out.native.body.instructions.flatMap((op, ip) =>
			op.opcode.startsWith("LOAD_PROPERTY") && "dst" in op
				? [
						{
							range: instructionResultIntegerRange(out.native.facts?.[ip], op.dst),
							representation: out.native.registerRepresentations[op.dst],
						},
					]
				: [],
		);
		expect(fields).toContainEqual({ range: bounded(0, 254), representation: "int32" });
		const make = out.image.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(out.image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "make",
		)!;
		expect(
			make.directEntries.find((entry) => entry.resultFields)!.resultFields!.storage[0]!
				.representation,
		).toBe("int32");
	});
	it.each(["limit", "+limit", "limit?-0:Infinity"])(
		"keeps a wide field when the comparison operand is %s",
		(bound) => {
			const out = inspectStaticValueFunction(
				`const make=function make(value,limit,hook){for(let i=0;i<3;i++)hook();const n=value>>>0;const bound=${bound};if(n<bound)return {n};return {n:0};};function compute(value,limit,hook){const record=make(value,limit,hook);hook();return record.n|0;}globalThis.make=make;globalThis.compute=compute;`,
				"compute",
			);
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(COMPILER_UINT32_RANGE);
			expect(out.native.registerRepresentations[op.dst]).toBe("number");
		},
	);
	it.each(["-0", "Infinity", "NaN"])(
		"keeps a conditional %s field outside the bounded integer kernel",
		(alternative) => {
			const out = inspectStaticValueFunction(
				`const make=function make(value,hook){for(let i=0;i<3;i++)hook(i);return value<0?{n:value&255}:{n:${alternative}};};function compute(value,hook){const record=make(value,hook);hook();return record.n%10;}globalThis.compute=compute;globalThis.make=make;`,
				"compute",
			);
			expect(out.c.source).toContain("mal_number_remainder(");
		},
	);
	it.each([false, true])(
		"keeps a merged field interval before a future write and escape (locked=%s)",
		(locked) => {
			const out = inspect("value&255", {
				locked,
				reader:
					"const alias=value?record:make(value+1,hook);const n=alias.n;alias.n='changed';hook(alias);return n%10;",
			});
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
			expect(out.native.registerRepresentations[op.dst]).toBe("int32");
			expect(out.c.source).not.toContain("mal_number_remainder(");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
	it.each(["function", "function*", "async function", "async function*"])(
		"carries a merged field interval through a %s entry",
		(declaration) => {
			const suspension =
				(declaration.includes("*") ? "yield 0;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspectStaticValueFunction(
				`const make=function make(value,hook){for(let i=0;i<3;i++)hook();return {n:value&255};};${declaration} compute(value,hook){const left=make(value,hook);const right=make(value+1,hook);const record=value?left:right;${suspension}if(value)record.n=value&15;hook();return record.n%10;}globalThis.compute=compute;`,
				"compute",
			);
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
			expect(out.native.registerRepresentations[op.dst]).toBe("int32");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
	it.each([false, true])(
		"retains common field facts through a conditional object return (locked=%s)",
		(locked) => {
			const out = inspectStaticValueFunction(
				`const make=function make(value,hook){for(let i=0;i<3;i++)hook(i);return value<0?{n:value&15,label:'negative'}:{n:value&255,label:'positive'};};function compute(value,hook){const record=make(value,hook);const n=record.n;const label=record.label;hook(record);return label+':'+n%10;}globalThis.compute=compute;globalThis.make=make;`,
				"compute",
				{ locked },
			);
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
			expect(out.c.source).not.toContain("mal_number_remainder(");
			expect(out.c.source).toContain("mal_vm_concat_strings_known(");
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
	it.each([false, true])(
		"consumes a bounded field across opaque calls (locked=%s)",
		(locked) => {
			const out = inspect("value&255", { locked });
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
			expect(out.native.registerRepresentations[op.dst]).toBe("int32");
			expect(out.c.source).not.toContain("mal_number_remainder(");
			const call = out.native.body.instructions.findIndex((op) => op.opcode === "CALL");
			expect(out.native.facts![call]!.effectMask! & INSTRUCTION_CALLS_USER_CODE).not.toBe(
				0,
			);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
	it.each([
		["value|0", COMPILER_INT32_RANGE],
		["value>>>0", COMPILER_UINT32_RANGE],
		["value&255", bounded(0, 255)],
	] as const)("retains the field domain of %s", (expression, range) => {
		const out = inspect(expression);
		const { op, facts } = field(out);
		expect(instructionResultIntegerRange(facts, op.dst)).toEqual(range);
		expect(out.native.registerRepresentations[op.dst]).toBe(
			expression === "value>>>0" ? "number" : "int32",
		);
	});

	it("keeps signed remainder semantics for an int32 field", () => {
		const out = inspect("value|0");
		expect(out.c.source).toContain("mal_number_remainder(");
	});
	it.each([
		"const n=record.n;record.n='changed';hook(record);return n%10;",
		"record.tag=99;hook();return record.n%10;",
	])("uses the initial field interval at its read despite %s", (reader) => {
		const out = inspect("value&255", { reader });
		const { op, facts } = field(out);
		expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
		expect(out.c.source).not.toContain("mal_number_remainder(");
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
			out.image,
		);
	});
	it.each(["function", "function*", "async function", "async function*"])(
		"keeps a previously read field interval after mutation in a %s",
		(declaration) => {
			const suspension =
				(declaration.includes("*") ? "yield 0;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspect("value&255", {
				declaration,
				reader: `const n=record.n;record.n='changed';${suspension}hook(record);return n%10;`,
			});
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
			expect(out.c.source).not.toContain("mal_number_remainder(");
		},
	);
	it.each(["make(...[value,hook])", "new make(value,hook)", "new make(...[value,hook])"])(
		"carries fields through %s",
		(call) => {
			const { op, facts } = field(inspect("value&255", { call }));
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
		},
	);
	it.each(["function", "function*", "async function", "async function*"])(
		"retains field ranges through the %s entry",
		(declaration) => {
			const suspension =
				(declaration.includes("*") ? "yield 0;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspect("value&255", {
				declaration,
				reader: `${suspension}hook();return record.n%10;`,
			});
			const { op, facts } = field(out);
			expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
			expect(out.c.source).not.toContain("mal_number_remainder(");
		},
	);
	it.each(["-0", "0/0", "1/0", "1.5", "+value"])(
		"keeps an unknown numeric field independent of its bounded sibling (%s)",
		(expression) => {
			const out = inspect(expression, {
				reader: "hook();return record.n+record.tag%10;",
			});
			const ranges = out.core
				.filter((op) => op.opcode === "loadPropertyStatic")
				.map((op) => op.attributes[CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE]);
			expect(ranges).toContainEqual(bounded(7, 7));
			expect(ranges).toContain(undefined);
		},
	);
	it.each(['record.n="changed";', "hook(record);", "record.missing;", "record[value];"])(
		"withdraws a range across %s",
		(before) => {
			const out = inspect("value&255", { reader: `${before}return record.n%10;` });
			for (const read of out.core.filter((op) => op.opcode === "loadPropertyStatic"))
				expect(
					read.attributes[CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE],
				).toBeUndefined();
		},
	);
	it("converges numeric calls and record reads in the same forwarding chain", () => {
		const out = inspectStaticValueFunction(
			`const leaf=function leaf(v,hook){try{hook();return v&255;}catch(e){throw e;}};const make=function make(v,hook){try{hook();return {n:leaf(v,hook)+1};}catch(e){throw e;}};const read=function read(v,hook){try{const r=make(v,hook);hook();return r.n*2;}catch(e){throw e;}};function compute(v,hook){const n=read(v,hook);hook();return n%10;}globalThis.leaf=leaf;globalThis.make=make;globalThis.read=read;globalThis.compute=compute;`,
			"compute",
		);
		const ip = out.native.body.instructions.findIndex(
			(op, ip) =>
				op.opcode === "CALL" &&
				out.native.facts?.[ip]?.resultIntegerRanges?.[0] !== undefined,
		);
		expect(out.native.facts![ip]!.resultIntegerRanges![0]).toEqual(bounded(2, 512));
		expect(out.c.source).not.toContain("mal_number_remainder(");
	});
	it("joins the bounds of complete finite record producers", () => {
		const out = inspectStaticValueFunction(
			`const left=function left(v,hook){try{hook();return {n:v&255};}catch(e){throw e;}};const right=function right(v,hook){try{hook();return {n:1024};}catch(e){throw e;}};function compute(v,hook,flag){const make=flag?left:right;const record=make(v,hook);hook();return record.n%10;}globalThis.compute=compute;`,
			"compute",
		);
		const { op, facts } = field(out);
		expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 1024));
	});
	it("converges stable mutually recursive fields without widening them", () => {
		const out = inspectStaticValueFunction(
			`const first=function first(depth,v,hook){try{hook();if(depth<=0)return {n:v&255};return second(depth-1,v,hook);}catch(e){throw e;}};const second=function second(depth,v,hook){try{hook();if(depth<=0)return {n:v&127};return first(depth-1,v,hook);}catch(e){throw e;}};function compute(depth,v,hook){const record=first(depth,v,hook);hook();return record.n%10;}globalThis.compute=compute;`,
			"compute",
		);
		const { op, facts } = field(out);
		expect(instructionResultIntegerRange(facts, op.dst)).toEqual(bounded(0, 255));
	});

	it("widens a growing recursive field while preserving an independent constant field", () => {
		const out = inspectStaticValueFunction(
			`const recur=function recur(depth,v,hook){try{hook();if(depth<=0)return {n:v&255,tag:7};const previous=recur(depth-1,v,hook);return {n:previous.n+1,tag:7};}catch(e){throw e;}};function compute(depth,v,hook){const record=recur(depth,v,hook);hook();return record.n+record.tag%10;}globalThis.recur=recur;globalThis.compute=compute;`,
			"compute",
		);
		const ranges = out.core
			.filter((op) => op.opcode === "loadPropertyStatic")
			.map((op) => op.attributes[CORE_NORMAL_RESULT_INTEGER_RANGE_ATTRIBUTE]);
		expect(ranges).toContainEqual(bounded(7, 7));
		expect(ranges).toContain(undefined);
	});
});
