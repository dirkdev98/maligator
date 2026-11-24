import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { format } from "oxfmt";
import type { FormatConfig } from "oxfmt";

const runtime = path.resolve("runtime/src");
const groups = [
	...readFileSync(path.join(runtime, "builtin_member_groups.h"), "utf8").matchAll(
		/^MAL_BUILTIN_MEMBER_GROUP\((\w+), (\w+)\)$/gm,
	),
].map(([, name, family]) => ({ name: name!, family: family! }));
const entries = new Map<
	string,
	Array<readonly [symbol: string, key: string, enumerable: boolean]>
>();
const nativeKeys = new Set<string>();
const nativeDependencies: Array<readonly [owner: string, key: string]> = [];
for (const directory of [
	runtime,
	path.join(runtime, "runtime"),
	path.join(runtime, "host"),
]) {
	for (const file of readdirSync(directory).filter((name) => /\.[ch]$/.test(name))) {
		const source = readFileSync(path.join(directory, file), "utf8");
		let nativeCode = source;
		for (const list of source.matchAll(
			/^MAL_DEFINE_(?:BUILTIN|CUSTOM)_MEMBER_GROUP\((\w+), (\w+)\)$/gm,
		)) {
			const [, group, macro] = list;
			const start = source.indexOf(`#define ${macro}(X)`);
			const body = start === -1 ? "" : source.slice(start, list.index);
			const rows = [...body.matchAll(/^ +X\((\w+), "([^"\n]+)", (\w+),/gm)];
			if (rows.length === 0 || entries.has(group!))
				throw new Error(`Invalid builtin member list ${group} in ${file}`);
			entries.set(
				group!,
				rows.map(
					([, symbol, key, define]) =>
						[
							symbol!,
							key!,
							!/^\d+$|^(?:mal_intrinsic_define_method_n|mal_iterator_helper_define_next|url_define_accessor)$/.test(
								define!,
							),
						] as const,
				),
			);
			nativeCode = nativeCode.replace(body, "");
		}
		// Names passed through native lookup tables and helpers are not source member reads.
		nativeCode = nativeCode.replaceAll(
			/MAL_BUILTIN_MEMBER_DEPENDENCY\((\w+),\s*"([^"\n]+)"\)/g,
			(_, owner: string, key: string) => {
				nativeDependencies.push([owner, key]);
				return "";
			},
		);
		nativeCode = nativeCode.replaceAll(/MAL_LOCAL_MEMBER_KEY\("[^"\n]+"\)/g, "");
		for (const [, name] of nativeCode.matchAll(/"([A-Za-z_$][A-Za-z_$0-9]*)"/g))
			nativeKeys.add(name!);
	}
}
const catalog = groups.map(({ name, family }) => {
	const members = entries.get(name);
	if (members === undefined) throw new Error(`Missing builtin member list ${name}`);
	entries.delete(name);
	return { name, family, members };
});
if (entries.size > 0)
	throw new Error(`Unregistered builtin member lists: ${[...entries.keys()].join(", ")}`);

const output = "src/compiler/frontend/builtin-member-data.ts";
const formatOptions = JSON.parse(readFileSync(".oxfmtrc.json", "utf8")) as FormatConfig;
const keys = new Set(catalog.flatMap(({ members }) => members.map(([, key]) => key)));
const symbols = new Set(
	catalog.flatMap(({ members }) => members.map(([symbol]) => symbol)),
);
for (const [owner, key] of nativeDependencies) {
	if (!keys.has(key) || (!symbols.has(owner) && !owner.startsWith("mal_host_install_")))
		throw new Error(`Unknown builtin member dependency ${owner}: ${key}`);
}
const nativeMemberNames = [...nativeKeys].filter((name) => keys.has(name)).sort();
const result = await format(
	output,
	[
		"// Generated from the runtime builtin member groups by scripts/generate-builtin-members.ts.",
		"export const BUILTIN_MEMBER_GROUPS: ReadonlyArray<{",
		"  name: string; family: string; members: ReadonlyArray<readonly [symbol: string, key: string, enumerable: boolean]>;",
		`}> = ${JSON.stringify(catalog, null, "\t")};`,
		`export const NATIVE_BUILTIN_MEMBER_NAMES: ReadonlyArray<string> = ${JSON.stringify(nativeMemberNames)};`,
		`export const NATIVE_BUILTIN_MEMBER_DEPENDENCIES: ReadonlyArray<readonly [owner: string, key: string]> = ${JSON.stringify(nativeDependencies.sort())};`,
	].join("\n"),
	formatOptions,
);
if (result.errors.length > 0) throw new Error(`Cannot format ${output}`);
if (process.argv.includes("--check")) {
	if (readFileSync(output, "utf8") !== result.code)
		throw new Error(`Regenerate ${output}`);
} else writeFileSync(output, result.code);
