import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildFingerprint,
	pruneArtifactDirectoryToSize,
} from "../src/test262/artifact-cache.ts";
import {
	test262NativeBuildInputs,
	test262SetNativeBuildInputs,
} from "../src/test262/runtime.ts";
import type { Test262NativeBuildInputs } from "../src/test262/runtime.ts";

describe("Test262 native build inputs", () => {
	it("keys build artifacts by exact flags and toolchain", () => {
		const initial = buildFingerprint(["-O0", "-DMAL_GC_GENERATIONAL=1"], "cc-a");
		expect(buildFingerprint(["-O0", "-DMAL_GC_GENERATIONAL=1"], "cc-a")).toBe(initial);
		expect(buildFingerprint(["-O1", "-DMAL_GC_GENERATIONAL=1"], "cc-a")).not.toBe(
			initial,
		);
		expect(buildFingerprint(["-O0", "-DMAL_GC_GENERATIONAL=1"], "cc-b")).not.toBe(
			initial,
		);
	});

	it("installs one serializable toolchain and named artifact bundle", () => {
		const inputs: Test262NativeBuildInputs = {
			toolchain: {
				tools: {
					cc: { path: "/tools/cc", version: "cc 1" },
					ar: { path: "/tools/ar", version: "ar 1" },
					rustup: { path: "/tools/rustup", version: "rustup 1" },
					cargo: { path: "/tools/cargo", version: "cargo 1" },
					rustc: { path: "/tools/rustc", version: "rustc 1" },
				},
				target: "native-target",
				rustTarget: "rust-target",
				probes: {
					c2x: true,
					lto: false,
					ltoFlags: [],
					strip: false,
					cxxLink: false,
					stripArgs: [],
					cxxLinkArgs: [],
				},
				fingerprint: "selected-toolchain",
				cacheHit: true,
			},
			artifacts: {
				c: { engine: "/artifacts/libLibMaligator.a" },
				rust: { linkArgs: ["/artifacts/libmal_rust.a", "-lpthread"] },
			},
			wireRunner: "/artifacts/Test262Wire",
		};

		const cloned = structuredClone(inputs);
		test262SetNativeBuildInputs(cloned);
		cloned.artifacts.rust.linkArgs.push("-lwrong");

		expect(test262NativeBuildInputs().toolchain.fingerprint).toBe("selected-toolchain");
		expect(test262NativeBuildInputs().artifacts).toEqual(inputs.artifacts);
		expect(test262NativeBuildInputs().wireRunner).toBe("/artifacts/Test262Wire");
	});

	it("bounds stale batch objects as atomic object/manifest entries", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test262-artifacts-"));
		try {
			for (const [index, key] of ["oldest", "middle", "newest"].entries()) {
				const used = new Date(1_000 + index * 1_000);
				for (const [extension, contents] of [
					["o", "12345678"],
					["json", "{}"],
				] as const) {
					const target = path.join(directory, `${key}.${extension}`);
					writeFileSync(target, contents);
					utimesSync(target, used, used);
				}
			}

			const result = pruneArtifactDirectoryToSize(directory, 12);

			expect(result).toEqual({
				beforeBytes: 30,
				afterBytes: 10,
				removedBytes: 20,
				removedEntries: 2,
			});
			expect(existsSync(path.join(directory, "oldest.o"))).toBe(false);
			expect(existsSync(path.join(directory, "middle.json"))).toBe(false);
			expect(existsSync(path.join(directory, "newest.o"))).toBe(true);
			expect(existsSync(path.join(directory, "newest.json"))).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
