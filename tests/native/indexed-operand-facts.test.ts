import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileBuildFrontend } from "../../src/build-frontend-cache.ts";
import {
	stripCompactTypes,
	TYPE_STRIPPER_IDENTITY,
} from "../../src/compiler/frontend/compact-type-strip.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../../src/compiler/target/compiler-artifact-codec.ts";
import {
	buildNativeProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { boxedNativeFactContract } from "../helpers/boxed-native-facts.ts";

it.each(["mutable", "locked"] as const)(
	"preserves indexed values, effects and boxed facts under %s primordials",
	(primordials) => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-indexed-facts-"));
		try {
			const fixture = "tests/local/indexed-operand-facts.mjs";
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_PRIMORDIALS: primordials },
			});
			const config = resolveBuildConfig({
				engine: { primordials, eval: false, realms: false },
				surface: { node: true },
			});
			const { programImage } = compileBuildFrontend({
				entrypoint: resolve(fixture),
				config,
				stripTypes: stripCompactTypes,
				stripperIdentity: TYPE_STRIPPER_IDENTITY,
				enforcePolicies: false,
			});
			const boxed = deserializeCompilerArtifact(
				serializeCompilerArtifact(boxedNativeFactContract(programImage)),
			);
			for (const [label, image, compiled] of [
				["ordinary", programImage, true],
				["boxed", boxed, true],
				["wire", programImage, false],
			] as const) {
				const binary = buildNativeProgramImage(image, {
					name: `indexed-facts-${primordials}-${label}`,
					outDir,
					mainFile: HOST_MAIN,
					config,
					nativeStackRoots: "precise",
					compiled,
				});
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", MAL_PRIMORDIALS: primordials, ...stress },
							timeoutMs: 120000,
						}),
						label,
					).toBe(expected);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	600000,
);
