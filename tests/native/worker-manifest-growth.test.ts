import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";
import { buildLocalBinary } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import {
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

it("loads a large worker manifest and releases its wires after successful and duplicate-name loads", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-manifest-growth-"));
	try {
		const config = resolveBuildConfig({
			engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
			surface: { node: false, webPlatform: false },
		});
		const image = compileEntrypoint("tests/local/fibertest_stub.js", {
			buildConfig: config,
		});
		const wire = serializeRuntimeImage(image.runtime);
		writeFileSync(path.join(directory, "fixture.malw"), wire);
		const entry = (index: number) => ({
			href: `file:///generated/worker-${String(index).padStart(6, "0")}.mjs`,
			wirePath: "fixture.malw",
			sha256: hash("sha256", wire, "hex"),
		});
		const entryCount = Math.ceil(
			(17 * 1024 * 1024) / (JSON.stringify(entry(0)).length + 1),
		);
		const entries = Array.from({ length: entryCount }, (_, index) =>
			entry(entryCount - index),
		);
		const source = JSON.stringify({ schema: 1, entries, poolEntry: entries[0]!.href });
		expect(Buffer.byteLength(source)).toBeGreaterThan(16 * 1024 * 1024);
		const manifest = path.join(directory, "workers.json");
		writeFileSync(manifest, source);
		const duplicate = path.join(directory, "duplicate.json");
		writeFileSync(
			duplicate,
			JSON.stringify({ schema: 1, entries: [entry(0), entry(0)] }),
		);
		const derivation = buildDerivationFromConfig(config);
		const binary = buildLocalBinary({
			context: resolveNativeBuildContext({
				features: { ...derivation.features, developmentApiEnabled: true },
			}),
			name: "worker-manifest-growth",
			outDir: directory,
			verbose: false,
			mainFile: "tests/fixtures/worker-manifest-growth/main.c",
			cSource: emitProgramTranslationUnits(image),
		}).binaryPath;
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(
			invocation.executable,
			[...invocation.args, manifest, duplicate],
			{
				encoding: "utf8",
				env: { ...process.env, MAL_GC_VERIFY: "1" },
				timeout: scaledNativeRunTimeoutMs(60_000),
			},
		);
		expect(result.error).toBeUndefined();
		expect(
			result.status,
			result.stderr || result.stdout || result.signal || "no status",
		).toBe(0);
		expect(result.stdout).toBe("worker-manifest-growth PASS\n");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 300_000);
