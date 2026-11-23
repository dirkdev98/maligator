import { readFileSync, writeFileSync } from "node:fs";
import { directBuiltinOperationIds } from "../src/compiler/shared/builtin-registry.ts";
import {
	knownOperations,
	knownOperationIndex,
	primordialBindings,
} from "../src/compiler/shared/known-operations.ts";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";

const guards = new Map<string, ReadonlyArray<string>>();
const active: Array<string> = [];
for (const line of readFileSync("runtime/src/intrinsics.h", "utf8").split("\n")) {
	const requires = /^\s*\/\* requires (MAL_\w+) \*\/$/.exec(line)?.[1];
	if (requires !== undefined) active.push(requires);
	else if (/^\s*\/\* end requires \*\/$/.test(line)) active.pop();
	else if (/^#(?:if|else|elif)/.test(line))
		throw new Error("Intrinsic numbering must not depend on preprocessor features");
	const intrinsic = /^\s*(MAL_INTRINSIC_\w+)(?:\s*=\s*[^,]+)?,/.exec(line)?.[1];
	if (intrinsic !== undefined) guards.set(intrinsic, [...active]);
}
const bindings = primordialBindings();
const catalog = getPrimordialCatalog();
const targetBits = 13;
const keyBits = 15;
if (bindings.length > 1 << targetBits) throw new Error("Too many primordial bindings");
const keyOffsets = new Map<string, number>();
let keyBytes = 0;
function keyOffset(key: string): number {
	const offset = keyOffsets.get(key);
	if (offset !== undefined) return offset;
	if (key.includes("\0")) throw new Error("Invalid primordial property name");
	keyOffsets.set(key, keyBytes);
	const start = keyBytes;
	keyBytes += Buffer.byteLength(key) + 1;
	if (keyBytes > 1 << keyBits)
		throw new Error("Primordial property names exceed the offset range");
	return start;
}
const rows = Array.from(bindings, (binding, index) => {
	const unavailable = `MAL_KNOWN_PRIMORDIAL(${index}, 0, 0, 0, false)`;
	if (binding === undefined) return unavailable;
	if (binding.kind === "intrinsic") {
		if (typeof binding.key !== "string") throw new Error("Invalid intrinsic binding");
		const conditions = guards.get(binding.key);
		if (conditions === undefined) throw new Error(`Missing intrinsic ${binding.key}`);
		const row = `MAL_KNOWN_PRIMORDIAL(${index}, 1, ${binding.key}, 0, false)`;
		return conditions.length === 0
			? row
			: `#if ${conditions.map((condition) => `(${condition})`).join(" && ")}\n${row}\n#else\n${unavailable}\n#endif`;
	}
	const kind = { prototype: 2, value: 3, getter: 4, setter: 5 }[binding.kind];
	const symbolKey = typeof binding.key !== "string";
	const key =
		binding.kind === "prototype"
			? 0
			: typeof binding.key === "string"
				? keyOffset(binding.key)
				: binding.key.symbol;
	return `MAL_KNOWN_PRIMORDIAL(${index}, ${kind}, ${binding.parent}, ${key}, ${symbolKey})`;
});
for (const operation of knownOperations()) {
	if (bindings[operation.node] === undefined)
		throw new Error(`Unreachable known operation ${operation.id}`);
}
writeFileSync(
	"runtime/src/generated/known_primordials.inc",
	[
		`#define MAL_KNOWN_PRIMORDIAL_COUNT ${catalog.nodes.length}`,
		`#define MAL_KNOWN_PRIMORDIAL_TARGET_BITS ${targetBits}`,
		`#define MAL_KNOWN_PRIMORDIAL_KEY_BITS ${keyBits}`,
		`#define MAL_KNOWN_OPERATION_COUNT ${knownOperations().length}`,
		"#ifdef MAL_KNOWN_PRIMORDIAL",
		...rows,
		"#endif",
		"#ifdef MAL_KNOWN_PRIMORDIAL_KEYS",
		...[...keyOffsets.keys()].map((key) => `${JSON.stringify(key)} "\\0"`),
		"#endif",
		"#ifdef MAL_KNOWN_OPERATION",
		...knownOperations().map(
			(operation, index) => `MAL_KNOWN_OPERATION(${index}, ${operation.node})`,
		),
		"#endif",
		"#ifdef MAL_KNOWN_SPECIALIZATION",
		...directBuiltinOperationIds.map(
			(id, index) => `MAL_KNOWN_SPECIALIZATION(${index}, ${knownOperationIndex(id)})`,
		),
		"#endif",
		"",
	].join("\n"),
);
