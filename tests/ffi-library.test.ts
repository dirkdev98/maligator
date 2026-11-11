import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config-values.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { prepareLibraries } from "../src/ffi/library.ts";
import { requireToolchain, toolArguments } from "../src/toolchain.ts";

describe("native library preparation identity", () => {
	it.each(["static", "shared"] as const)(
		"invalidates a replaced %s library at the same path",
		(link) => {
			const { cc, ar } = requireToolchain({ needsCxx: false }).tools;
			const compiler = cc.path;
			const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-library-"));
			const execute = (tool: string, args: Array<string>) => {
				const result = spawnSync(tool, args, { encoding: "utf8", timeout: 15_000 });
				expect(
					result.status,
					[result.error?.message, result.stderr, result.stdout]
						.filter(Boolean)
						.join("\n"),
				).toBe(0);
				return result.stdout;
			};
			try {
				const source = path.join(directory, "linked.c");
				const object = path.join(directory, "linked.o");
				const library = path.join(
					directory,
					`liblinked${link === "static" ? ".a" : process.platform === "darwin" ? ".dylib" : ".so"}`,
				);
				writeFileSync(path.join(directory, "linked.h"), "int linked_value(void);\n");
				writeFileSync(
					path.join(directory, "linked.ffi.ts"),
					`export default ${JSON.stringify({ headers: ["linked.h"], find: [{ includeDirs: ["."], libraryDirs: ["."], libraries: ["linked"] }] })};\n`,
				);
				const replace = (value: number) => {
					writeFileSync(source, `int linked_value(void) { return ${value}; }\n`);
					if (link === "static") {
						execute(compiler, toolArguments(cc, ["-c", source, "-o", object]));
						execute(ar.path, toolArguments(ar, ["rcs", library, object]));
					} else
						execute(
							compiler,
							toolArguments(cc, [
								process.platform === "darwin" ? "-dynamiclib" : "-shared",
								"-fPIC",
								source,
								"-o",
								library,
							]),
						);
				};
				const config = resolveBuildConfig({
					ffi: { linked: { contract: "linked.ffi.ts", link } },
				});
				const preparation = {
					projectRoot: directory,
					stripTypes: stripCompactTypes,
					compiler: {
						path: compiler,
						version: cc.version,
					},
					environment: process.env,
					platform: process.platform,
					cross: false,
				};
				replace(1);
				const before = prepareLibraries(config, preparation);
				expect(before.dependencies).toContain(library);
				expect(prepareLibraries(config, preparation).identity).toBe(before.identity);
				replace(2);
				const after = prepareLibraries(config, preparation);
				expect(after.modules).toEqual(before.modules);
				expect(after.identity).not.toBe(before.identity);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
