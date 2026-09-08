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
	if (line.startsWith("#if ")) active.push(line.slice(4));
	else if (line === "#endif") active.pop();
	else if (/^#(?:else|elif)/.test(line))
		throw new Error("Unsupported intrinsic feature branch");
	const intrinsic = /^\s*(MAL_INTRINSIC_\w+)(?:\s*=\s*[^,]+)?,/.exec(line)?.[1];
	if (intrinsic !== undefined) guards.set(intrinsic, [...active]);
}
const bindings = primordialBindings();
const catalog = getPrimordialCatalog();
const rows = Array.from(bindings, (binding, index) => {
	const unavailable = `MAL_KNOWN_PRIMORDIAL(${index}, 0, -1, 0, nullptr, -1)`;
	if (binding === undefined) return unavailable;
	if (binding.kind === "intrinsic") {
		if (typeof binding.key !== "string") throw new Error("Invalid intrinsic binding");
		const conditions = guards.get(binding.key);
		if (conditions === undefined) throw new Error(`Missing intrinsic ${binding.key}`);
		const row = `MAL_KNOWN_PRIMORDIAL(${index}, 1, -1, ${binding.key}, nullptr, -1)`;
		return conditions.length === 0
			? row
			: `#if ${conditions.map((condition) => `(${condition})`).join(" && ")}\n${row}\n#else\n${unavailable}\n#endif`;
	}
	const kind = { prototype: 2, value: 3, getter: 4, setter: 5 }[binding.kind];
	const key = typeof binding.key === "string" ? JSON.stringify(binding.key) : "nullptr";
	const symbol = typeof binding.key === "string" ? -1 : binding.key.symbol;
	return `MAL_KNOWN_PRIMORDIAL(${index}, ${kind}, ${binding.parent}, 0, ${key}, ${symbol})`;
});
for (const operation of knownOperations()) {
	if (bindings[operation.node] === undefined)
		throw new Error(`Unreachable known operation ${operation.id}`);
}
writeFileSync(
	"runtime/src/generated/known_primordials.inc",
	[
		`#define MAL_KNOWN_PRIMORDIAL_COUNT ${catalog.nodes.length}`,
		`#define MAL_KNOWN_OPERATION_COUNT ${knownOperations().length}`,
		"#ifdef MAL_KNOWN_PRIMORDIAL",
		...rows,
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
