import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeBuildEnvironmentFingerprint } from "../src/native-build-context.ts";
import { normalizeRuntimeBuildArgument } from "../src/native-cache-identity.ts";

describe("native cache identity", () => {
	it("removes checkout-specific runtime paths", () => {
		const runtime = "/checkout/runtime";
		expect(normalizeRuntimeBuildArgument(runtime, `${runtime}/src/vm.c`)).toBe(
			"<runtime>/src/vm.c",
		);
		expect(
			normalizeRuntimeBuildArgument(runtime, `-ffile-prefix-map=${runtime}=<runtime>`),
		).toBe("-ffile-prefix-map=<runtime>=<runtime>");
		expect(normalizeRuntimeBuildArgument(runtime, "/toolchain/include")).toBe(
			"/toolchain/include",
		);
	});

	it("reuses the native environment identity across nested npm PATH prefixes", () => {
		const npmPrefix = ["/checkout/node_modules/.bin", "/npm/node-gyp-bin"];
		const searchPath = [...npmPrefix, "/toolchain/bin", "/usr/bin"];
		const direct = Object.freeze({ PATH: searchPath.join(path.delimiter), CC: "clang" });
		const nested = Object.freeze({
			...direct,
			PATH: [...npmPrefix, ...searchPath].join(path.delimiter),
		});
		const nestedPath = nested.PATH;

		expect(nativeBuildEnvironmentFingerprint(nested)).toBe(
			nativeBuildEnvironmentFingerprint(direct),
		);
		expect(nested.PATH).toBe(nestedPath);
	});

	it("retains the first occurrence and executable search order", () => {
		const first = { PATH: ["/compiler/a", "/compiler/b"].join(path.delimiter) };
		const duplicate = {
			PATH: ["/compiler/a", "/compiler/b", "/compiler/a"].join(path.delimiter),
		};
		const reordered = { PATH: ["/compiler/b", "/compiler/a"].join(path.delimiter) };
		expect(nativeBuildEnvironmentFingerprint(duplicate)).toBe(
			nativeBuildEnvironmentFingerprint(first),
		);
		expect(nativeBuildEnvironmentFingerprint(reordered)).not.toBe(
			nativeBuildEnvironmentFingerprint(first),
		);
	});

	it.each(["/compiler/new", "", ".", "/compiler/a/", "/Compiler/a"])(
		"keeps a distinct PATH entry %j in the environment identity",
		(entry) => {
			expect(
				nativeBuildEnvironmentFingerprint({
					PATH: ["/compiler/a", entry].join(path.delimiter),
				}),
			).not.toBe(nativeBuildEnvironmentFingerprint({ PATH: "/compiler/a" }));
		},
	);

	it("distinguishes unset PATH from an empty search component", () => {
		expect(nativeBuildEnvironmentFingerprint({ PATH: undefined })).toBe(
			nativeBuildEnvironmentFingerprint({}),
		);
		expect(nativeBuildEnvironmentFingerprint({ PATH: "" })).not.toBe(
			nativeBuildEnvironmentFingerprint({}),
		);
		expect(nativeBuildEnvironmentFingerprint({ PATH: path.delimiter })).toBe(
			nativeBuildEnvironmentFingerprint({ PATH: "" }),
		);
	});

	it.each([
		["CFLAGS", "-O2", "-O1"],
		["RUSTFLAGS", "-Copt-level=3", "-Copt-level=1"],
		["CARGO_PROFILE_RELEASE_LTO", "true", "false"],
	])("keeps changes to %s in the environment identity", (name, before, after) => {
		const base = { PATH: "/compiler/a" };
		expect(nativeBuildEnvironmentFingerprint({ ...base, [name]: before })).not.toBe(
			nativeBuildEnvironmentFingerprint({ ...base, [name]: after }),
		);
	});
});
