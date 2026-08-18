import { describe, expect, it } from "vitest";
import { buildFingerprint } from "../src/test262/artifact-cache.ts";
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
});
