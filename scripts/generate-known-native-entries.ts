import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { knownOperations } from "../src/compiler/shared/known-operations.ts";

interface Binding {
	id: string;
	symbol: string;
}
interface Source {
	path: string;
	text: string;
}
const input = process.argv[2];
if (input === undefined)
	throw new Error(
		"Usage: node scripts/generate-known-native-entries.ts <native-bindings.json>",
	);
const bindings = JSON.parse(readFileSync(input, "utf8")) as Array<Binding>;
const sources: Array<Source> = [
	"runtime/src",
	"runtime/src/host",
	"runtime/src/runtime",
].flatMap((directory) =>
	readdirSync(directory)
		.filter((name) => name.endsWith(".c"))
		.map((name) => ({
			path: `${directory}/${name}`,
			text: readFileSync(`${directory}/${name}`, "utf8"),
		})),
);

function definition(source: Source, symbol: string): number | undefined {
	const functionMatch = new RegExp(`(?:static\\s+)?MalValue\\s+${symbol}\\s*\\(`).exec(
		source.text,
	);
	if (functionMatch !== null) return functionMatch.index;
	const macroMatch = new RegExp(`^[A-Z][A-Z_0-9]+\\(\\s*${symbol}\\s*[,)]`, "m").exec(
		source.text,
	);
	if (macroMatch !== null) return macroMatch.index;
	for (const macro of source.text.matchAll(
		/^#define\s+(\w+)\(([^)]*)\)(?:[^\n]*\\\n)*[^\n]*/gm,
	)) {
		const template = /MalValue\s+([\w#]+)\s*\(/.exec(macro[0])?.[1];
		if (template === undefined) continue;
		const parameters = macro[2]!.split(",").map((parameter) => parameter.trim());
		for (const invocation of source.text.matchAll(
			new RegExp(`^${macro[1]}\\(([^\\n]*)`, "gm"),
		)) {
			const values = invocation[1]!
				.split(",")
				.map((value) => value.trim().replace(/\).*$/, ""));
			const name = template
				.split("##")
				.map((part) =>
					parameters.includes(part) ? values[parameters.indexOf(part)] : part,
				)
				.join("");
			if (name === symbol) return invocation.index;
		}
	}
	return undefined;
}

function conditions(source: Source, offset: number): Array<string> {
	const stack: Array<{ branches: Array<string>; current: string }> = [];
	for (const line of source.text.slice(0, offset).split("\n")) {
		const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)/.exec(line);
		if (directive === null) continue;
		const [, kind, raw] = directive,
			expression = raw!.replace(/\/\/.*$/, "").trim();
		if (kind === "endif") stack.pop();
		else if (kind === "elif" || kind === "else") {
			const top = stack.at(-1);
			if (top === undefined) throw new Error(`Unmatched branch in ${source.path}`);
			top.current = `!(${top.branches.map((branch) => `(${branch})`).join(" || ")})${kind === "elif" ? ` && (${expression})` : ""}`;
			if (kind === "elif") top.branches.push(expression);
		} else {
			const condition =
				kind === "ifdef"
					? `defined(${expression})`
					: kind === "ifndef"
						? `!defined(${expression})`
						: expression;
			stack.push({ branches: [condition], current: condition });
		}
	}
	return stack.map((frame) => frame.current);
}

const arguments_ =
	"MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee";
const entries = new Map<
	string,
	{ source: Source; name: string; guards: Array<string> }
>();
const operations = knownOperations().map((operation) => {
	const binding = bindings.find((binding) => binding.id === operation.id);
	if (binding === undefined) throw new Error(`Missing native binding ${operation.id}`);
	let entry = entries.get(binding.symbol);
	if (entry === undefined) {
		const definitions = sources.flatMap((source) => {
			const offset = definition(source, binding.symbol);
			return offset === undefined ? [] : [{ source, offset }];
		});
		if (definitions.length !== 1)
			throw new Error(
				`Expected one definition for ${binding.symbol}: ${definitions.map((definition) => definition.source.path).join(", ")}`,
			);
		const { source, offset } = definitions[0]!;
		entry = {
			source,
			name: `mal_known_native_${binding.symbol}`,
			guards: conditions(source, offset),
		};
		entries.set(binding.symbol, entry);
	}
	return entry.name;
});
for (const source of sources) {
	const owned = [...entries].filter(([, entry]) => entry.source === source);
	if (owned.length === 0) continue;
	const name = source.path.replace(/^runtime\/src\//, "").replace(/[/.]/g, "_");
	const include = `#include "generated/known_native_${name}.inc"`;
	writeFileSync(
		`runtime/src/generated/known_native_${name}.inc`,
		[
			'#include "vm.h"',
			...owned.map(([symbol, entry]) =>
				[
					`MalValue ${entry.name}(${arguments_}) {`,
					...(entry.guards.length === 0
						? []
						: [`#if ${entry.guards.map((guard) => `(${guard})`).join(" && ")}`]),
					`    return ${symbol}(vm, receiver, args, count, target, callee);`,
					...(entry.guards.length === 0
						? []
						: [
								"#else",
								"    (void) receiver; (void) args; (void) count; (void) target; (void) callee;",
								'    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");',
								"    return mal_value_new_undefined();",
								"#endif",
							]),
					"}",
				].join("\n"),
			),
			"",
		].join("\n"),
	);
	if (!source.text.includes(include))
		writeFileSync(source.path, `${source.text.trimEnd()}\n\n${include}\n`);
}
writeFileSync(
	"runtime/src/generated/known_native_entries.inc",
	`${[...entries.values()].map((entry) => `MalValue ${entry.name}(${arguments_});`).join("\n")}\n`,
);
writeFileSync(
	"src/compiler/shared/known-native-entries.ts",
	`// Generated from the native descriptor inventory and runtime source definitions.\nlet entries: ReadonlyArray<string> | undefined;\nexport function knownNativeEntries(): ReadonlyArray<string> {\n\treturn entries ??= JSON.parse(${JSON.stringify(JSON.stringify(operations))}) as ReadonlyArray<string>;\n}\n`,
);
console.log(
	`Generated ${entries.size} native entries for ${operations.length} operations`,
);
