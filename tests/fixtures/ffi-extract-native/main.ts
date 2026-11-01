/* oxlint-disable no-console -- The fixture reports the declarations a native extractor reads. */
import { spawnSync } from "node:child_process";
import { extractCModel } from "../../../src/ffi/c-extract.ts";

const include = process.env.MAL_FFI_HEADER_DIR;
if (include === undefined) throw new Error("MAL_FFI_HEADER_DIR is required");
const compiler = process.env.MAL_FFI_COMPILER ?? "cc";
const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error(version.stderr);
const model = extractCModel({
	compiler: { path: compiler, version: version.stdout.split("\n")[0]! },
	environment: process.env,
	headers: ["large.h"],
	compileArguments: [`-I${include}`],
});
console.log(
	JSON.stringify({
		functions: model.functions.map(({ name, params, returns, doc, location }) => ({
			name,
			params,
			returns,
			doc,
			location,
		})),
		fields: model.records.get("LargeValue")?.fields,
	}),
);
