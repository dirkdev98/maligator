/* oxlint-disable no-console -- The fixture reports the declarations a native extractor reads. */
import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import { extractCModel } from "../../../src/ffi/c-extract.ts";
import { loadCModel } from "../../../src/ffi/model-cache.ts";

const include = process.env.MAL_FFI_HEADER_DIR;
if (include === undefined) throw new Error("MAL_FFI_HEADER_DIR is required");
const compiler = process.env.MAL_FFI_COMPILER ?? "cc";
const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error(version.stderr);
const input = {
	compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
	environment: process.env,
	headers: ["large.h"],
	compileArguments: [`-I${include}`],
};
const cached = process.env.MAL_FFI_CACHE === "1";
const model = cached ? loadCModel(input) : extractCModel(input);
console.log(
	JSON.stringify({
		functions: model.functions.map(({ name, params, returns, doc, location }) =>
			cached
				? {
						name,
						docLength: doc?.length,
						docHash: doc === undefined ? null : hash("sha256", doc),
					}
				: { name, params, returns, doc, location },
		),
		fields: model.records.get("LargeValue")?.fields,
		...(cached
			? {
					enums: [...model.enums.values()].map((entry) => ({
						name: entry.name,
						constants: entry.constants.map(({ name, value }) => ({
							name,
							value: value.toString(),
						})),
					})),
					macros: model.macros.map(({ name, value }) => ({
						name,
						value: value?.toString(),
					})),
				}
			: {}),
	}),
);
