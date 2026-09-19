import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDirectory = path.join(repositoryRoot, "bench/runtime-gap/cases");
const generated = new Map<string, string>();

function add(id: string, source: string): void {
	generated.set(
		id,
		`import { runRuntimeGapCase } from "../case-runner.mjs";\n\n${source.trim()}\n\nrunRuntimeGapCase(${JSON.stringify(id)}, run${source.includes("function verify()") ? ", verify" : ""});\n`,
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
if (stale.length > 0)
	throw new Error(`stale runtime-gap microcases:\n${stale.join("\n")}`);
console.log(
	`${check ? "checked" : "generated"} ${generated.size} runtime-gap microcases`,
);
