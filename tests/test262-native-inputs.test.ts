import { describe, expect, it } from "vitest";
import {
	test262NativeBuildInputs,
	test262SetNativeBuildInputs,
} from "../src/test262/runtime.ts";
import type { Test262NativeBuildInputs } from "../src/test262/runtime.ts";

describe("Test262 native build inputs", () => {
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
		};

		const cloned = structuredClone(inputs);
		test262SetNativeBuildInputs(cloned);
		cloned.artifacts.rust.linkArgs.push("-lwrong");

		expect(test262NativeBuildInputs().toolchain.fingerprint).toBe("selected-toolchain");
		expect(test262NativeBuildInputs().artifacts).toEqual(inputs.artifacts);
	});
});
