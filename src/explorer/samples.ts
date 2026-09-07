import type { ExplorerConfig, ExplorerLanguage } from "./config.ts";

export interface Trail {
	readonly title: string;
	readonly explanation: string;
	readonly queries: Partial<Record<ViewId, string>>;
}

export interface Sample {
	readonly language?: ExplorerLanguage;
	readonly config?: Partial<ExplorerConfig>;
	readonly id: string;
	readonly group: string;
	readonly title: string;
	readonly summary: string;
	readonly source: string;
	readonly trails: ReadonlyArray<Trail>;
}

export type StageId = "preCore" | "optimizedCore" | "target" | "malw" | "c";
export type ViewId = "source" | StageId;
export type ModeId = "generic" | "full";

export const SAMPLES: ReadonlyArray<Sample> = [
	{
		id: "constants",
		group: "Data",
		title: "Constants & strings",
		summary:
			"Integer and floating immediates, UTF-16 strings, BigInts, booleans, null, and undefined.",
		source: `const integer = 42;
const floating = 3.5;
const text = "café 🐊";
const huge = 0x123456789abcdef0123456789n;
globalThis.constants = [integer, floating, text, huge, true, null, undefined];`,
		trails: [
			{
				title: "String pool",
				explanation:
					"Strings are interned as UTF-16 code-unit arrays, then referenced by pool index from VM instructions and C tables.",
				queries: {
					source: '"café 🐊"',
					preCore: "createString",
					optimizedCore: "createString",
					target: "createString",
					malw: "CREATE_STRING",
					c: "_code_units",
				},
			},
			{
				title: "BigInt pool",
				explanation:
					"BigInt literals use a separate 128-bit constant pool: low 64 bits followed by high 64 bits in MALW.",
				queries: {
					source: "0x123456789abcdef0123456789n",
					preCore: "createBigint",
					optimizedCore: "createBigint",
					target: "createBigint",
					malw: "CREATE_BIGINT",
					c: "mal_bigints",
				},
			},
		],
	},
	{
		id: "constant-folding",
		group: "Optimization",
		title: "Folding & dead code",
		summary:
			"A deliberately reducible expression and unreachable branch expose what disappears before either backend.",
		source: `function answer(flag) {
	const folded = (6 * 7) + (8 - 8);
	if (flag && false) return 999;
	return folded + 1;
}
globalThis.answer = answer(true);`,
		trails: [
			{
				title: "Arithmetic folding",
				explanation:
					"Compare the raw binary operations with the optimized constant and its final VM/C representation.",
				queries: {
					source: "(6 * 7)",
					preCore: "binary",
					optimizedCore: "createNumber",
					malw: "CREATE_NUMBER",
					c: " = 43;",
				},
			},
		],
	},
	{
		id: "control-flow",
		group: "Control",
		title: "Branches & loops",
		summary:
			"SSA block edges become allocated jumps, bytecode instruction pointers, and native labels.",
		source: `function sum(limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		total += index % 2 === 0 ? index : -index;
	}
	return total;
}
globalThis.total = sum(8);`,
		trails: [
			{
				title: "Control-flow edges",
				explanation:
					"Core names SSA blocks and edge arguments; the runtime terminal resolves them into instruction-pointer jumps.",
				queries: {
					source: "for (let index",
					preCore: "branch",
					optimizedCore: "branch",
					target: "jumpIf",
					malw: "JUMP_IF",
					c: "goto L",
				},
			},
		],
	},
	{
		id: "closures",
		group: "Functions",
		title: "Closures & captures",
		summary:
			"Nested function identity, captured cells, environment creation, and calls through a returned closure.",
		source: `function makeCounter(start) {
	let value = start;
	return function increment(step) {
		value += step;
		return value;
	};
}
const counter = makeCounter(10);
globalThis.count = counter(2) + counter(3);`,
		trails: [
			{
				title: "Captured cell",
				explanation:
					"The source binding becomes an environment slot; loads and stores survive only where the closure cannot be scalarized.",
				queries: {
					source: "value += step",
					preCore: "Captured",
					optimizedCore: "Captured",
					target: "Captured",
					malw: "CAPTURED",
					c: "captured",
				},
			},
		],
	},
	{
		id: "objects",
		group: "Data",
		title: "Objects & shapes",
		summary:
			"A contained object literal shows slot forwarding, scalar replacement, and the generic shaped-object fallback.",
		source: `function update(value) {
	const point = { x: value, y: value + 1 };
	point.x = point.x + point.y;
	return point.x;
}
globalThis.point = update(4);`,
		trails: [
			{
				title: "Scalar replacement",
				explanation:
					"The raw Core graph creates a shaped object. Full optimization forwards its exact own slots and jointly erases the contained identity and final store.",
				queries: {
					source: "point.x",
					preCore: "createObjectShaped",
					optimizedCore: "binary",
					target: '"operator": "+"',
					malw: "BINARY",
					c: "MAL_BIN_ADD",
				},
			},
		],
	},
	{
		id: "arrays",
		group: "Data",
		title: "Arrays & iteration",
		summary:
			"Array construction, indexed stores, length access, and iterator protocol lowering.",
		source: `function collect(values) {
	const doubled = [];
	for (const value of values) doubled.push(value * 2);
	return doubled.length;
}
globalThis.length = collect([1, 2, 3]);`,
		trails: [
			{
				title: "Iteration protocol",
				explanation:
					"A for-of begins as iterator operations; optimized output may replace parts only when its proof and fallback obligations are satisfied.",
				queries: {
					source: "for (const value",
					preCore: "Iterator",
					optimizedCore: "Iterator",
					target: "iterator",
					malw: "ITERATOR",
					c: "iterator",
				},
			},
		],
	},
	{
		id: "builtins",
		group: "Calls",
		title: "Calls & builtins",
		summary:
			"Ordinary calls beside recognized Math and String operations reveal generic, guarded, and direct lowering choices.",
		source: `function normalize(text, value) {
	const trimmed = text.trim();
	return trimmed + ":" + Math.floor(Math.abs(value));
}
globalThis.label = normalize("  score  ", -4.8);`,
		trails: [
			{
				title: "Builtin recognition",
				explanation:
					"Core owns the semantic proof; target metadata records whether the final output can use a direct or guarded builtin operation.",
				queries: {
					source: "Math.floor",
					preCore: "call",
					optimizedCore: "call",
					target: "guardedBuiltinCall",
					malw: "guardedMathCall",
					c: "builtin_math",
				},
			},
		],
	},
	{
		id: "exceptions",
		group: "Control",
		title: "Exceptions & finally",
		summary:
			"Abrupt completion crosses a catch and finally region, producing handlers and explicit completion flow.",
		source: `function guarded(value) {
	try {
		if (value < 0) throw new RangeError("negative");
		return value * 2;
	} catch (error) {
		return error.name;
	} finally {
		globalThis.cleaned = true;
	}
}
globalThis.result = guarded(-1);`,
		trails: [
			{
				title: "Handler table",
				explanation:
					"Core exception edges become TRY/CATCH instructions plus a compact runtime handler range table.",
				queries: {
					source: "try",
					preCore: "handler",
					optimizedCore: "handler",
					target: "try",
					malw: "handlers",
					c: "handler",
				},
			},
		],
	},
	{
		id: "classes",
		group: "Functions",
		title: "Classes & construction",
		summary:
			"Constructor metadata, private state, method functions, and new-target construction.",
		source: `class Box {
	#value;
	constructor(value) { this.#value = value; }
	read() { return this.#value; }
}
globalThis.boxed = new Box(7).read();`,
		trails: [
			{
				title: "Construction contract",
				explanation:
					"Class and constructor flags live on function records; construction and private access remain explicit operations.",
				queries: {
					source: "new Box",
					preCore: "construct",
					optimizedCore: "construct",
					target: "construct",
					malw: "CONSTRUCT",
					c: "mal_vm_construct_direct",
				},
			},
		],
	},
	{
		id: "async",
		group: "Suspension",
		title: "Async & await",
		summary:
			"An async function exposes coroutine function metadata, suspension points, and resumable native lowering.",
		source: `async function addLater(value) {
	const next = await Promise.resolve(value + 1);
	return next * 2;
}
globalThis.pending = addLater(20);`,
		trails: [
			{
				title: "Await suspension",
				explanation:
					"Await is preserved as a resumable operation; the function kind selects coroutine state handling in both terminals.",
				queries: {
					source: "await",
					preCore: "await",
					optimizedCore: "await",
					target: "await",
					malw: "AWAIT",
					c: "mal_vm_op_await_compiled",
				},
			},
		],
	},
	{
		id: "generators",
		group: "Suspension",
		title: "Generators & yield",
		summary:
			"Generator initialization, yields, resume state, and iterator-facing function metadata.",
		source: `function* sequence(limit) {
	for (let index = 0; index < limit; index++) yield index * index;
	return limit;
}
globalThis.iterator = sequence(3);`,
		trails: [
			{
				title: "Yield suspension",
				explanation:
					"Yield becomes an explicit bytecode suspension point and a resumable C state-machine boundary.",
				queries: {
					source: "yield",
					preCore: "yield",
					optimizedCore: "yield",
					target: "yield",
					malw: "YIELD",
					c: "mal_vm_op_yield_compiled",
				},
			},
		],
	},
	{
		id: "typed-functions",
		group: "TypeScript",
		title: "Erasable types",
		summary:
			"Interfaces, annotations and assertions disappear before JavaScript enters the compiler. Types are not checked.",
		language: "typescript",
		source: `interface Point { x: number; y: number }
type Coordinate = number;
function sum(point: Point): Coordinate {
  return point.x + point.y;
}
const point = { x: 20, y: 22 } satisfies Point;
globalThis.answer = sum(point);`,
		trails: [],
	},
];
