import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";
import type {
	RuntimeGapCaseDescriptor,
	RuntimeGapCategory,
} from "./runtime-gap-catalog.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDirectory = path.join(repositoryRoot, "bench/runtime-gap/cases");
const catalogPath = path.join(repositoryRoot, "bench/runtime-gap/catalog.json");
const generated = new Map<string, string>();
const generatedDescriptors = new Map<string, RuntimeGapCaseDescriptor>();

function add(id: string, source: string): void {
	generated.set(
		id,
		`import { runRuntimeGapCase } from "../case-runner.mjs";\n\n${source.trim()}\n\nrunRuntimeGapCase(${JSON.stringify(id)}, run${source.includes("function verify()") ? ", verify" : ""});\n`,
	);
}

function addBenchmark(
	descriptor: Omit<RuntimeGapCaseDescriptor, "fixture">,
	source: string,
): void {
	add(descriptor.id, source);
	generatedDescriptors.set(descriptor.id, {
		...descriptor,
		fixture: `cases/${descriptor.id}.mjs`,
	});
}

function addRuntimeBenchmark(
	id: string,
	metadata: {
		readonly owner: string;
		readonly category: RuntimeGapCategory;
		readonly mechanisms: ReadonlyArray<string>;
		readonly inputShape: string;
		readonly unit: string;
		readonly sourceSeam: string;
		readonly controls?: ReadonlyArray<string>;
	},
	source: string,
): void {
	addBenchmark(
		{
			id,
			group: "runtime",
			suite: "runtime",
			...metadata,
			controls: metadata.controls ?? [],
		},
		source,
	);
}

function fieldClass(
	privateField: boolean,
	count: number,
	position: "first" | "last",
): string {
	const prefix = privateField ? "#" : "";
	const fields = Array.from({ length: count }, (_, index) => `${prefix}value${index}`);
	return `class Reader {
${fields.map((field) => `\t${field};`).join("\n")}
	constructor(value) {
${fields.map((field, index) => `\t\tthis.${field} = (value + ${index}) & 255;`).join("\n")}
	}
	read() {
		return this.${position === "first" ? fields[0] : fields.at(-1)};
	}
}`;
}

for (const count of [1, 8, 32]) {
	for (const position of count === 1 ? ["first"] : ["first", "last"]) {
		for (const privateField of [false, true]) {
			for (const receiver of ["known", "selected"]) {
				const kind = privateField ? "private" : "public";
				const id = `${kind}-field-read-${count}-${position}-${receiver}`;
				const access =
					receiver === "known"
						? "checksum = (checksum + reader.read()) | 0;"
						: "checksum = (checksum + readers[index & 31].read()) | 0;";
				add(
					id,
					`const seed = Number(process.argv[2] ?? "1") & 255;

${fieldClass(privateField, count, position as "first" | "last")}

const readers = Array.from({ length: 32 }, (_, index) => new Reader(seed + index));
const reader = readers[seed & 31];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		${access}
	}
	return { checksum: checksum >>> 0, operations };
}`,
				);
			}
		}
	}
}

for (const privateMethod of [false, true]) {
	for (const receiver of ["known", "selected"]) {
		const kind = privateMethod ? "private" : "public";
		const id = `${kind}-method-call-${receiver}`;
		const step = privateMethod
			? `\t#step(value) {
		return (value + this.offset) & 255;
	}
	run(value) {
		return this.#step(value);
	}`
			: `\tstep(value) {
		return (value + this.offset) & 255;
	}
	run(value) {
		return this.step(value);
	}`;
		const call =
			receiver === "known"
				? "checksum = (checksum + stepper.run(index & 255)) | 0;"
				: "checksum = (checksum + steppers[index & 31].run(index & 255)) | 0;";
		add(
			id,
			`const seed = Number(process.argv[2] ?? "1") & 255;

class Stepper {
	offset;
	constructor(offset) {
		this.offset = offset;
	}
${step}
}

const steppers = Array.from({ length: 32 }, (_, index) => new Stepper(seed + index));
const stepper = steppers[seed & 31];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		${call}
	}
	return { checksum: checksum >>> 0, operations };
}`,
		);
	}
}

for (const size of [16, 256, 4_096]) {
	for (const hit of [true, false]) {
		for (const weak of [false, true]) {
			for (const receiver of ["known", "selected"]) {
				const collection = weak ? "weakmap" : "map";
				const outcome = hit ? "hit" : "miss";
				const id = `${collection}-get-${outcome}-${size}-${receiver}`;
				const get =
					receiver === "known"
						? "const value = collection.get(lookupKeys[index & mask]);"
						: "const value = collections[(index >>> 8) & 1].get(lookupKeys[index & mask]);";
				add(
					id,
					`const seed = Number(process.argv[2] ?? "1") & 255;
const keys = Array.from({ length: ${size} }, (_, index) => ({ index, seed }));
const misses = Array.from({ length: ${size} }, (_, index) => ({ index, seed: seed + 1 }));
const entries = keys.map((key, index) => [key, (index + seed) & 255]);
const collections = [new ${weak ? "WeakMap" : "Map"}(entries), new ${weak ? "WeakMap" : "Map"}(entries)];
const collection = collections[seed & 1];
const lookupKeys = ${hit ? "keys" : "misses"};
const mask = ${size - 1};

function run(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		${get}
		checksum = (checksum + (value === undefined ? 1 : value)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
				);
			}
		}
	}
}

for (const keyKind of ["int", "string", "symbol"] as const) {
	for (const hit of [true, false]) {
		const outcome = hit ? "hit" : "miss";
		const id = `map-get-${outcome}-4096-selected-${keyKind}-key`;
		const keys =
			keyKind === "int"
				? "Array.from({ length: 4_096 }, (_, index) => seed * 16_384 + index)"
				: keyKind === "string"
					? "Array.from({ length: 4_096 }, (_, index) => `key:${seed}:${index}`)"
					: "Array.from({ length: 4_096 }, (_, index) => Symbol(`key:${seed}:${index}`))";
		const misses =
			keyKind === "int"
				? "Array.from({ length: 4_096 }, (_, index) => (seed + 1) * 16_384 + index)"
				: keyKind === "string"
					? "Array.from({ length: 4_096 }, (_, index) => `miss:${seed}:${index}`)"
					: "Array.from({ length: 4_096 }, (_, index) => Symbol(`miss:${seed}:${index}`))";
		add(
			id,
			`const seed = Number(process.argv[2] ?? "1") & 255;
const keys = ${keys};
const misses = ${misses};
const entries = keys.map((key, index) => [key, (index + seed) & 255]);
const maps = [new Map(entries), new Map(entries)];
const lookupKeys = ${hit ? "keys" : "misses"};

function run(scale) {
	let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = maps[(index >>> 8) & 1].get(lookupKeys[index & 4_095]);
		checksum = (checksum + (value === undefined ? 1 : value)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
		);
	}
}

add(
	"array-includes-int32-miss-long",
	`const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 2_048 }, (_, index) => (seed + arrayIndex + index) & 2_047),
);
const misses = Array.from({ length: 2_048 }, (_, index) => -(index + 1));

function run(scale) {
	let checksum = 0;
	const operations = 25_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += arrays[(index >>> 8) & 31].includes(misses[index & 2_047]) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
);

add(
	"array-includes-int32-hit-short",
	`const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 8 }, (_, index) => seed + arrayIndex + index),
);

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		const array = arrays[(index >>> 8) & 31];
		checksum += array.includes(array[index & 7]) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
);

for (const method of ["indexOf", "lastIndexOf"] as const) {
	const id = `array-${method === "indexOf" ? "index-of" : "last-index-of"}-int32-hit-short`;
	add(
		id,
		`const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 8 }, (_, index) => seed + arrayIndex + index),
);

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		const array = arrays[(index >>> 8) & 31];
		checksum = (checksum + array.${method}(array[index & 7])) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
	);
}

add(
	"array-includes-mixed-number-hit",
	`const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: 2_048 }, (_, index) =>
		index & 1 ? seed + arrayIndex + index + 0.5 : seed + arrayIndex + index,
	),
);

function run(scale) {
	let checksum = 0;
	const operations = 200_000 * scale;
	for (let index = 0; index < operations; index++) {
		const array = arrays[(index >>> 8) & 31];
		checksum += array.includes(array[index & 2_047]) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
);

add(
	"array-includes-signed-zero",
	`const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, () => [seed, -0, 0, seed + 1]);
const needles = [-0, 0];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += arrays[(index >>> 8) & 31].includes(needles[index & 1]) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
);

add(
	"array-includes-nan",
	`const seed = Number(process.argv[2] ?? "1") & 255;
const nan = Number(process.argv[3] ?? "not-a-number");
const arrays = Array.from({ length: 32 }, (_, arrayIndex) => [seed + arrayIndex, nan]);

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum += arrays[(index >>> 8) & 31].includes(nan) ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
);

for (const order of ["adjacent", "interleaved"]) {
	const id = `map-get-set-${order}`;
	const operations =
		order === "adjacent"
			? `const leftValue = left.get(key);
		left.set(key, (leftValue + 1) & 255);
		const rightValue = right.get(key);
		right.set(key, (rightValue + 1) & 255);`
			: `const leftValue = left.get(key);
		const rightValue = right.get(key);
		left.set(key, (leftValue + 1) & 255);
		right.set(key, (rightValue + 1) & 255);`;
	add(
		id,
		`const seed = Number(process.argv[2] ?? "1") & 255;
const keys = Array.from({ length: 256 }, (_, index) => ({ index, seed }));
const initial = keys.map((_, index) => (index + seed) & 255);
const left = new Map(keys.map((key, index) => [key, initial[index]]));
const right = new Map(keys.map((key, index) => [key, initial[index]]));

function run(scale) {
	let checksum = 0;
	const iterations = 65_536 * scale;
	for (let index = 0; index < iterations; index++) {
		const key = keys[index & 255];
		${operations}
		checksum = (checksum + leftValue + rightValue) | 0;
	}
	return { checksum: checksum >>> 0, operations: iterations * 4 };
}

function verify() {
	for (let index = 0; index < keys.length; index++) {
		if (left.get(keys[index]) !== initial[index] || right.get(keys[index]) !== initial[index]) {
			throw new Error("Map contents did not return to their prepared state");
		}
	}
}`,
	);
}

for (const destructure of [false, true]) {
	const id = destructure ? "pair-destructure" : "pair-indexed-control";
	const load = destructure
		? "const [left, right] = pairs[index & 1_023];"
		: `const pair = pairs[index & 1_023];
		const left = pair[0];
		const right = pair[1];`;
	add(
		id,
		`const seed = Number(process.argv[2] ?? "1") & 255;
const pairs = Array.from({ length: 1_024 }, (_, index) => [index & 255, (index + seed) & 255]);

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		${load}
		checksum = (checksum + left + right) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
	);
}

for (const typed of [false, true]) {
	for (const at of [false, true]) {
		for (const receiver of ["known", "selected"]) {
			const kind = typed ? "typed-array" : "array";
			const access = at ? "at-negative" : "last-index-control";
			const id = `${kind}-${access}-${receiver}`;
			const receiverSetup =
				receiver === "known" ? "" : "const selected = arrays[(index >>> 8) & 31];\n\t\t";
			const receiverExpression = receiver === "known" ? "array" : "selected";
			const read = `${receiverSetup}const value = ${
				at
					? `${receiverExpression}.at(-1)`
					: `${receiverExpression}[${receiverExpression}.length - 1]`
			};`;
			add(
				id,
				`const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	${typed ? "new Int32Array(Array.from({ length: 8 }, (_, index) => seed + arrayIndex + index))" : "Array.from({ length: 8 }, (_, index) => seed + arrayIndex + index)"},
);
const array = arrays[seed & 31];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		${read}
		checksum = (checksum + value) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
			);
		}
	}
}

for (const variant of ["unique", "unrelated-control", "collision"] as const) {
	const id = `method-name-${variant}`;
	const otherMethod = variant === "collision" ? "read" : "inspect";
	const otherClass =
		variant === "unique"
			? ""
			: `
class Other {
	inspectOffset;
	constructor(offset) {
		this.inspectOffset = offset;
	}
	${otherMethod}(value) {
		return (value + this.inspectOffset) & 255;
	}
}
const other = new Other(seed + 3);`;
	const verification =
		variant === "unique"
			? `function verify() {}`
			: `function verify() {
	if (other.${otherMethod}(seed) !== ((seed * 2 + 3) & 255)) {
		throw new Error("unrelated method was not retained");
	}
}`;
	addRuntimeBenchmark(
		id,
		{
			owner: "instance method name collision",
			category: "language-features",
			mechanisms: ["instance-method-hints"],
			inputShape: `${variant}, 32 prepared receivers`,
			unit: "method call",
			sourceSeam: "src/compiler/core/core-instance-method-hints.ts",
			controls:
				variant === "collision"
					? ["method-name-unrelated-control"]
					: variant === "unrelated-control"
						? ["method-name-unique"]
						: [],
		},
		`const seed = Number(process.argv[2] ?? "1") & 255;

class Reader {
	offset;
	constructor(offset) {
		this.offset = offset;
	}
	read(value) {
		return (value + this.offset) & 255;
	}
}
${otherClass}
const readers = Array.from({ length: 32 }, (_, index) => new Reader(seed + index));

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + readers[index & 31].read(index & 255)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

${verification}`,
	);
}

for (const valueKind of ["numeric", "array"] as const) {
	for (const count of [1, 8, 32]) {
		for (const form of [
			"public-assignment",
			"public-initializer",
			"private-initializer",
		] as const) {
			const id = `private-field-construction-${valueKind}-${form}-${count}`;
			const privateField = form === "private-initializer";
			const prefix = privateField ? "#" : "";
			const fields = Array.from(
				{ length: count },
				(_, index) => `${prefix}value${index}`,
			);
			const value = (index: number): string =>
				valueKind === "array" ? "[]" : `(seed + ${index}) & 255`;
			const declarations =
				form === "public-assignment"
					? ""
					: `${fields.map((field, index) => `\t${field} = ${value(index)};`).join("\n")}\n`;
			const assignments =
				form === "public-assignment"
					? `${fields.map((field, index) => `\t\tthis.${field} = ${value(index)};`).join("\n")}\n`
					: "";
			const sample =
				valueKind === "array" ? `this.${fields.at(-1)}.length` : `this.${fields.at(-1)}`;
			const expected = valueKind === "array" ? "0" : `(seed + ${count - 1}) & 255`;
			addRuntimeBenchmark(
				id,
				{
					owner: "private field construction",
					category: "allocation-gc",
					mechanisms: ["class-field-initialization"],
					inputShape: `${count} ${valueKind} fields, ${form}`,
					unit: "constructed instance",
					sourceSeam: "runtime/src/vm_ops.c",
					controls:
						form === "private-initializer"
							? [`private-field-construction-${valueKind}-public-initializer-${count}`]
							: form === "public-initializer"
								? [`private-field-construction-${valueKind}-public-assignment-${count}`]
								: [],
				},
				`const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
${declarations}\tinput;
	constructor(input) {
${assignments}\t\tthis.input = input;
	}
	sample() {
		return ${sample};
	}
}

const retained = new Array(256);

function run(scale) {
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		retained[index & 255] = new Record((seed + index) & 255);
	}
	return { checksum: (operations + seed) >>> 0, operations };
}

function verify() {
	for (const record of retained) {
		if (!(record instanceof Record) || record.sample() !== ${expected}) {
			throw new Error("constructed field state differs");
		}
	}
}`,
			);
		}
	}
}

for (const variant of [
	"direct",
	"fresh",
	"reused",
	"reporting-fresh",
	"reporting-reused",
] as const) {
	const id = `fresh-captured-callback-${variant}`;
	const reporting = variant.startsWith("reporting-");
	const reuse = variant.endsWith("reused");
	const direct = variant === "direct";
	const expression = direct
		? "value + 1"
		: reuse
			? `${reporting ? "invokeWithReporting" : "invoke"}(reusedCallback)`
			: `${reporting ? "invokeWithReporting" : "invoke"}(() => value + 1)`;
	addRuntimeBenchmark(
		id,
		{
			owner: "fresh captured callback",
			category: "allocation-gc",
			mechanisms: ["closure-allocation", "function-closure-dispatch"],
			inputShape: variant,
			unit: "callback result",
			sourceSeam: "runtime/src/function_object.c",
			controls: direct
				? []
				: reporting
					? ["fresh-captured-callback-reporting-reused"]
					: [reuse ? "fresh-captured-callback-direct" : "fresh-captured-callback-reused"],
		},
		`const seed = Number(process.argv[2] ?? "1") & 255;
const reportingEnabled = process.argv[4] === "report";
let currentValue = 0;
let reports = 0;

function invoke(callback) {
	return callback();
}

function invokeWithReporting(callback) {
	const result = callback();
	if (reportingEnabled) reports = (reports + result) | 0;
	return result;
}

function reusedCallback() {
	return currentValue + 1;
}

function run(scale) {
	let checksum = 0;
	const operations = 250_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = (seed + index) & 255;
		${reuse ? "currentValue = value;" : ""}
		checksum = (checksum + ${expression}) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	if (!reportingEnabled && reports !== 0) throw new Error("disabled reporting ran");
}`,
	);
}

for (const environments of [1, 64]) {
	for (const representation of ["lexical", "object"] as const) {
		const id = `shared-mutable-capture-${representation}-${environments}`;
		const factory =
			representation === "lexical"
				? `function makeCell(initial) {
	let value = initial;
	return {
		get: () => value,
		set: (next) => {
			value = next;
		},
	};
}`
				: `function makeCell(initial) {
	const cell = { value: initial };
	return {
		get: () => cell.value,
		set: (next) => {
			cell.value = next;
		},
	};
}`;
		addRuntimeBenchmark(
			id,
			{
				owner: "shared mutable closure capture",
				category: "language-features",
				mechanisms: ["closure-environment-access"],
				inputShape: `${environments} prepared environments, ${representation} state`,
				unit: "set/get pair",
				sourceSeam: "runtime/src/function_object.c",
				controls:
					representation === "lexical"
						? [`shared-mutable-capture-object-${environments}`]
						: [],
			},
			`const seed = Number(process.argv[2] ?? "1") & 255;

${factory}

const cells = Array.from({ length: ${environments} }, (_, index) => makeCell(seed + index));

function run(scale) {
	let checksum = 0;
	const iterations = 250_000 * scale;
	for (let index = 0; index < iterations; index++) {
		const cell = cells[index & ${environments - 1}];
		cell.set((seed + index) & 255);
		checksum = (checksum + cell.get()) | 0;
	}
	return { checksum: checksum >>> 0, operations: iterations * 2 };
}`,
		);
	}
}

for (const disabled of [false, true]) {
	for (const withFinally of [false, true]) {
		const mode = disabled ? "disabled" : "plain";
		const form = withFinally ? "finally" : "control";
		const id = `try-finally-call-no-throw-${mode}-${form}`;
		const body = withFinally
			? `let result;
	try {
		result = callback(value);
	} finally {
		${disabled ? "if (reportingEnabled) state.completed++;" : "state.completed++;"}
	}
	return result;`
			: `const result = callback(value);
	${disabled ? "if (reportingEnabled) state.completed++;" : "state.completed++;"}
	return result;`;
		addRuntimeBenchmark(
			id,
			{
				owner: "try/finally callback call",
				category: "language-features",
				mechanisms: ["try-finally-control-flow", "function-closure-dispatch"],
				inputShape: `${mode}, prepared callback, no throw`,
				unit: "wrapped callback call",
				sourceSeam: "runtime/src/vm_ops.c",
				controls: withFinally ? [`try-finally-call-no-throw-${mode}-control`] : [],
			},
			`const seed = Number(process.argv[2] ?? "1") & 255;
const reportingEnabled = process.argv[4] === "report";
const state = { completed: 0 };

function callback(value) {
	return (value + seed) & 255;
}

function invoke(value) {
	${body}
}

function run(scale) {
	let checksum = 0;
	const operations = 250_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + invoke(index & 255)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
		);
	}
}

for (const length of [1, 4, 16]) {
	for (const outcome of ["equal", "first-mismatch", "last-mismatch"] as const) {
		for (const variant of ["indexed", "captured", "reused"] as const) {
			const id = `short-every-${variant}-${length}-${outcome}`;
			const comparison =
				variant === "indexed"
					? "indexedEvery(values, expected)"
					: variant === "captured"
						? "values.every((value, position) => value === expected[position])"
						: "(currentExpected = expected, values.every(reusedPredicate))";
			const mutation =
				outcome === "equal"
					? ""
					: outcome === "first-mismatch"
						? "values[0] = values[0] + 1;"
						: `values[${length - 1}] = values[${length - 1}] + 1;`;
			addRuntimeBenchmark(
				id,
				{
					owner: "short Array.every with captured expected array",
					category: "api-builtins",
					mechanisms: ["array-callback", "closure-allocation"],
					inputShape: `length ${length}, ${outcome}, ${variant} predicate`,
					unit: "array comparison",
					sourceSeam: "runtime/src/builtin_array.c",
					controls:
						variant === "indexed" ? [] : [`short-every-indexed-${length}-${outcome}`],
				},
				`const seed = Number(process.argv[2] ?? "1") & 255;
const expectedArrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: ${length} }, (_, index) => (seed + arrayIndex + index) & 255),
);
const valueArrays = expectedArrays.map((expected) => {
	const values = expected.slice();
	${mutation}
	return values;
});
let currentExpected = expectedArrays[0];

function reusedPredicate(value, position) {
	return value === currentExpected[position];
}

function indexedEvery(values, expected) {
	for (let position = 0; position < values.length; position++) {
		if (values[position] !== expected[position]) return false;
	}
	return true;
}

function run(scale) {
	let checksum = 0;
	const operations = 100_000 * scale;
	for (let index = 0; index < operations; index++) {
		const selected = index & 31;
		const values = valueArrays[selected];
		const expected = expectedArrays[selected];
		checksum += ${comparison} ? 1 : 0;
	}
	return { checksum: checksum >>> 0, operations };
}`,
			);
		}
	}
}

for (const stream of ["absent", "present", "mixed"] as const) {
	for (const variant of ["control", "spread"] as const) {
		const id = `conditional-empty-spread-${variant}-${stream}`;
		const previous =
			stream === "absent"
				? "undefined"
				: stream === "present"
					? "(seed + index - 1) & 255"
					: "index & 1 ? (seed + index - 1) & 255 : undefined";
		const construction =
			variant === "spread"
				? "{ value, ...(previous === undefined ? {} : { previous }) }"
				: "previous === undefined ? { value } : { value, previous }";
		addRuntimeBenchmark(
			id,
			{
				owner: "conditional empty object spread",
				category: "allocation-gc",
				mechanisms: ["object-spread", "conditional-object-allocation"],
				inputShape: `${stream} previous value, ${variant}`,
				unit: "constructed record",
				sourceSeam: "runtime/src/object.c",
				controls:
					variant === "spread" ? [`conditional-empty-spread-control-${stream}`] : [],
			},
			`const seed = Number(process.argv[2] ?? "1") & 255;
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = (seed + index) & 255;
		const previous = ${previous};
		const record = ${construction};
		retained[index & 255] = record;
		checksum = (checksum + value + (previous === undefined ? 0 : 1)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const record of retained) {
		if (record === undefined) throw new Error("record was not retained");
		if (("previous" in record) !== (record.previous !== undefined)) {
			throw new Error("conditional spread changed property absence");
		}
	}
}`,
		);
	}
}

for (const propertyCount of [4, 16]) {
	const sourceProperties = Array.from(
		{ length: propertyCount },
		(_, index) => `p${index}: (seed + ${index}) & 255`,
	).join(", ");
	const fixedProperties = Array.from(
		{ length: propertyCount },
		(_, index) => `p${index}: source.p${index}`,
	).join(", ");
	for (const keyKind of ["existing", "new"] as const) {
		const key = keyKind === "existing" ? `p${propertyCount - 1}` : "extra";
		for (const frozen of [false, true]) {
			const sourceState = frozen ? "frozen" : "mutable";
			for (const variant of ["spread", "clone-assign", "fixed-copy"] as const) {
				const createBody =
					variant === "spread"
						? "return { ...source, [key]: replacement };"
						: variant === "clone-assign"
							? `const copy = { ...source };
	copy[key] = replacement;
	return copy;`
							: `const copy = { ${fixedProperties} };
	copy[key] = replacement;
	return copy;`;
				for (const phase of ["construct", "read"] as const) {
					const id = `spread-computed-update-${phase}-${propertyCount}-${keyKind}-${sourceState}-${variant}`;
					const control = `spread-computed-update-${phase}-${propertyCount}-${keyKind}-${sourceState}-${
						variant === "spread" ? "clone-assign" : "fixed-copy"
					}`;
					const setup =
						phase === "construct"
							? "const retained = new Array(256);"
							: `const copies = Array.from({ length: 32 }, (_, index) =>
	create((seed + index) & 255),
);`;
					const run =
						phase === "construct"
							? `let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const replacement = (seed + index) & 255;
		retained[index & 255] = create(replacement);
		checksum = (checksum + replacement) | 0;
	}
	return { checksum: checksum >>> 0, operations };`
							: `let checksum = 0;
	const operations = 500_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + copies[index & 31][key]) | 0;
	}
	return { checksum: checksum >>> 0, operations };`;
					const verification =
						phase === "construct"
							? `function verify() {
	for (const copy of retained) {
		if (copy === undefined || copy[key] === undefined) {
			throw new Error("computed update was not retained");
		}
	}
}`
							: "";
					addRuntimeBenchmark(
						id,
						{
							owner: "object spread with computed update",
							category:
								phase === "construct" ? "allocation-gc" : "object-array-representation",
							mechanisms: ["object-spread", "computed-property-store"],
							inputShape: `${propertyCount} properties, ${keyKind} key, ${sourceState} source, ${variant}, ${phase}`,
							unit: phase === "construct" ? "constructed record" : "property read",
							sourceSeam: "runtime/src/object.c",
							controls: variant === "fixed-copy" ? [] : [control],
						},
						`const seed = Number(process.argv[2] ?? "1") & 255;
const key = "${key}";
const source = ${frozen ? "Object.freeze" : ""}({ ${sourceProperties} });

function create(replacement) {
	${createBody}
}

${setup}

function run(scale) {
	${run}
}

${verification}`,
					);
				}
			}
		}
	}
}

for (const length of [0, 2, 8, 32]) {
	for (const frozen of [false, true]) {
		for (const method of ["spread", "slice"] as const) {
			const sourceState = frozen ? "frozen" : "mutable";
			const id = `frozen-array-copy-${method}-${sourceState}-${length}`;
			const copy = method === "spread" ? "[...source]" : "source.slice()";
			addRuntimeBenchmark(
				id,
				{
					owner: "frozen array copy",
					category: "allocation-gc",
					mechanisms: ["array-copy", "frozen-array"],
					inputShape: `length ${length}, ${sourceState} source, ${method}`,
					unit: "array copy",
					sourceSeam: "runtime/src/builtin_array.c",
					controls: frozen
						? [`frozen-array-copy-${method}-mutable-${length}`]
						: method === "spread"
							? [`frozen-array-copy-slice-mutable-${length}`]
							: [],
				},
				`const seed = Number(process.argv[2] ?? "1") & 255;
const source = ${frozen ? "Object.freeze(" : ""}Array.from(
	{ length: ${length} },
	(_, index) => (seed + index) & 255,
)${frozen ? ")" : ""};
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const copy = ${copy};
		retained[index & 255] = copy;
		checksum = (checksum + copy.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const copy of retained) {
		if (!Array.isArray(copy) || copy.length !== source.length) {
			throw new Error("array copy differs");
		}
	}
}`,
			);
		}
	}
}

for (const propertyCount of [2, 8, 32]) {
	for (const method of ["keys", "entries"] as const) {
		const id = `object-entries-small-${method}-${propertyCount}`;
		const properties = Array.from(
			{ length: propertyCount },
			(_, index) => `p${index}: (seed + ${index}) & 255`,
		).join(", ");
		addRuntimeBenchmark(
			id,
			{
				owner: "small Object.entries materialization",
				category: "api-builtins",
				mechanisms: ["object-enumeration", "array-allocation"],
				inputShape: `${propertyCount} stable string properties, Object.${method}`,
				unit: "enumeration call",
				sourceSeam: "runtime/src/object.c",
				controls:
					method === "entries" ? [`object-entries-small-keys-${propertyCount}`] : [],
			},
			`const seed = Number(process.argv[2] ?? "1") & 255;
const records = Array.from({ length: 32 }, () => ({ ${properties} }));
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = Object.${method}(records[index & 31]);
		retained[index & 255] = result;
		checksum = (checksum + result.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (!Array.isArray(result) || result.length !== ${propertyCount}) {
			throw new Error("object enumeration differs");
		}
	}
}`,
		);
	}
}

for (const size of [2, 8, 32]) {
	for (const keys of ["distinct", "repeated"] as const) {
		for (const variant of ["indexed", "builtin"] as const) {
			const id = `object-from-entries-small-${variant}-${keys}-${size}`;
			const construction =
				variant === "builtin"
					? "Object.fromEntries(pairs)"
					: `(() => {
			const result = {};
			for (let position = 0; position < pairs.length; position++) {
				result[pairs[position][0]] = pairs[position][1];
			}
			return result;
		})()`;
			const expectedKeys = keys === "distinct" ? size : Math.min(size, 2);
			addRuntimeBenchmark(
				id,
				{
					owner: "small Object.fromEntries construction",
					category: "api-builtins",
					mechanisms: ["object-from-entries", "computed-property-store"],
					inputShape: `${size} ${keys} string-key pairs, ${variant}`,
					unit: "constructed object",
					sourceSeam: "runtime/src/object.c",
					controls:
						variant === "builtin"
							? [`object-from-entries-small-indexed-${keys}-${size}`]
							: [],
				},
				`const seed = Number(process.argv[2] ?? "1") & 255;
const pairs = Array.from({ length: ${size} }, (_, index) => [
	${keys === "distinct" ? '"p" + index' : '"p" + (index & 1)'},
	(seed + index) & 255,
]);
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = ${construction};
		retained[index & 255] = result;
		checksum = (checksum + ${expectedKeys}) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (result === undefined || Object.keys(result).length !== ${expectedKeys}) {
			throw new Error("fromEntries result differs");
		}
	}
}`,
			);
		}
	}
}

for (const length of [0, 8, 64]) {
	for (const variant of ["direct", "indirect-single", "indirect-multiple"] as const) {
		const id = `indirect-typed-array-construction-${variant}-${length}`;
		const allocation =
			variant === "direct"
				? `new Int32Array(${length})`
				: `allocate(Int32Array, ${length})`;
		const secondary =
			variant === "indirect-multiple"
				? "const secondary = allocate(Uint32Array, 1);"
				: "";
		const verification =
			variant === "indirect-multiple"
				? `
	if (!(secondary instanceof Uint32Array)) {
		throw new Error("secondary constructor path was not retained");
	}`
				: "";
		addRuntimeBenchmark(
			id,
			{
				owner: "indirect typed-array construction",
				category: "allocation-gc",
				mechanisms: ["indirect-constructor-call", "typed-array-allocation"],
				inputShape: `Int32Array length ${length}, ${variant}`,
				unit: "typed-array construction",
				sourceSeam: "runtime/src/typed_array.c",
				controls:
					variant === "direct"
						? []
						: [`indirect-typed-array-construction-direct-${length}`],
			},
			`function allocate(Construct, length) {
	return new Construct(length);
}

${secondary}
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 20_000 * scale;
	for (let index = 0; index < operations; index++) {
		const value = ${allocation};
		retained[index & 255] = value;
		checksum = (checksum + value.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const value of retained) {
		if (!(value instanceof Int32Array) || value.length !== ${length}) {
			throw new Error("typed-array construction differs");
		}
	}${verification}
}`,
		);
	}
}

for (const size of [1, 3, 8]) {
	for (const position of size === 1 ? ["first"] : (["first", "last"] as const)) {
		for (const variant of ["indexed", "splice"] as const) {
			const id = `tiny-splice-extract-${variant}-${size}-${position}`;
			const selected = position === "first" ? "0" : `${size - 1}`;
			const operation =
				variant === "splice"
					? `const value = available.splice(selected, 1)[0];
		available.splice(selected, 0, value);`
					: `const value = available[selected];
		for (let cursor = selected; cursor < available.length - 1; cursor++) {
			available[cursor] = available[cursor + 1];
		}
		available.pop();
		for (let cursor = available.length; cursor > selected; cursor--) {
			available[cursor] = available[cursor - 1];
		}
		available[selected] = value;`;
			addRuntimeBenchmark(
				id,
				{
					owner: "tiny array splice extraction",
					category: "api-builtins",
					mechanisms: ["array-splice", "array-element-shift"],
					inputShape: `length ${size}, remove ${position}, ${variant}`,
					unit: "remove/restore pair",
					sourceSeam: "runtime/src/builtin_array.c",
					controls:
						variant === "splice"
							? [`tiny-splice-extract-indexed-${size}-${position}`]
							: [],
				},
				`const seed = Number(process.argv[2] ?? "1") & 255;
const arrays = Array.from({ length: 32 }, (_, arrayIndex) =>
	Array.from({ length: ${size} }, (_, index) => (seed + arrayIndex + index) & 255),
);
const selected = ${selected};

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const available = arrays[index & 31];
		${operation}
		checksum = (checksum + value) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const available of arrays) {
		if (available.length !== ${size}) throw new Error("array was not restored");
	}
}`,
			);
		}
	}
}

for (const rows of [4, 16]) {
	for (const width of [0, 1, 2]) {
		for (const variant of ["indexed", "flatmap"] as const) {
			const id = `short-flatmap-${variant}-${rows}-${width}`;
			const flatten =
				variant === "flatmap"
					? "preparedRows.flatMap((row) => row.values)"
					: `(() => {
			const result = [];
			for (let row = 0; row < preparedRows.length; row++) {
				const values = preparedRows[row].values;
				for (let position = 0; position < values.length; position++) {
					result.push(values[position]);
				}
			}
			return result;
		})()`;
			addRuntimeBenchmark(
				id,
				{
					owner: "short Array.flatMap",
					category: "api-builtins",
					mechanisms: ["array-flatmap", "array-callback"],
					inputShape: `${rows} rows, width ${width}, ${variant}`,
					unit: "flattened row set",
					sourceSeam: "runtime/src/builtin_array.c",
					controls:
						variant === "flatmap" ? [`short-flatmap-indexed-${rows}-${width}`] : [],
				},
				`const seed = Number(process.argv[2] ?? "1") & 255;
const preparedRows = Array.from({ length: ${rows} }, (_, row) => ({
	values: Array.from({ length: ${width} }, (_, column) => (seed + row + column) & 255),
}));
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 10_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = ${flatten};
		retained[index & 255] = result;
		checksum = (checksum + result.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (!Array.isArray(result) || result.length !== ${rows * width}) {
			throw new Error("flatMap result differs");
		}
	}
}`,
			);
		}
	}
}

for (const variant of ["indexed", "flatmap"] as const) {
	const id = `short-flatmap-${variant}-16-mixed`;
	const flatten =
		variant === "flatmap"
			? "preparedRows.flatMap((row) => row.values)"
			: `(() => {
		const result = [];
		for (let row = 0; row < preparedRows.length; row++) {
			const values = preparedRows[row].values;
			for (let position = 0; position < values.length; position++) {
				result.push(values[position]);
			}
		}
		return result;
	})()`;
	addRuntimeBenchmark(
		id,
		{
			owner: "short Array.flatMap",
			category: "api-builtins",
			mechanisms: ["array-flatmap", "array-callback"],
			inputShape: `16 rows, mixed widths 0 through 2, ${variant}`,
			unit: "flattened row set",
			sourceSeam: "runtime/src/builtin_array.c",
			controls: variant === "flatmap" ? ["short-flatmap-indexed-16-mixed"] : [],
		},
		`const seed = Number(process.argv[2] ?? "1") & 255;
const preparedRows = Array.from({ length: 16 }, (_, row) => ({
	values: Array.from({ length: row % 3 }, (_, column) => (seed + row + column) & 255),
}));
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 10_000 * scale;
	for (let index = 0; index < operations; index++) {
		const result = ${flatten};
		retained[index & 255] = result;
		checksum = (checksum + result.length) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (const result of retained) {
		if (!Array.isArray(result) || result.length !== 15) {
			throw new Error("mixed flatMap result differs");
		}
	}
}`,
	);
}

mkdirSync(caseDirectory, { recursive: true });
const check = process.argv.includes("--check");
const stale: Array<string> = [];
for (const [id, source] of generated) {
	const output = path.join(caseDirectory, `${id}.mjs`);
	const formatted = (await format(output, source, { printWidth: 90, useTabs: true }))
		.code;
	if (check) {
		if (readFileSync(output, "utf8") !== formatted) stale.push(output);
	} else {
		writeFileSync(output, formatted);
	}
}
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
	readonly schema: number;
	readonly presets: unknown;
	readonly cases: ReadonlyArray<RuntimeGapCaseDescriptor>;
};
const generatedIds = new Set(generatedDescriptors.keys());
const updatedCatalog = {
	...catalog,
	cases: [
		...catalog.cases.filter(({ id }) => !generatedIds.has(id)),
		...generatedDescriptors.values(),
	],
};
const formattedCatalog = (
	await format(catalogPath, `${JSON.stringify(updatedCatalog, undefined, "\t")}\n`, {
		printWidth: 90,
		useTabs: true,
	})
).code;
if (check) {
	if (readFileSync(catalogPath, "utf8") !== formattedCatalog) stale.push(catalogPath);
} else {
	writeFileSync(catalogPath, formattedCatalog);
}
if (stale.length > 0)
	throw new Error(`stale runtime-gap microcases:\n${stale.join("\n")}`);
console.log(
	`${check ? "checked" : "generated"} ${generated.size} runtime-gap microcases`,
);
