import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixtures = path.resolve("tests/fixtures/image-domains");
const config = resolveBuildConfig({ surface: { webPlatform: true, node: false } });

function writeDomain(directory: string, generation: "first" | "second"): string {
	const entries = ["worker", "leaf", "receiver"].map((name) => {
		const entrypoint = path.join(fixtures, `${name}.mts`);
		const source = readFileSync(entrypoint, "utf8").replace(
			'const generation = "first";',
			`const generation = "${generation}";`,
		);
		const image = compileEntrypoint(entrypoint, {
			buildConfig: config,
			entrySource: source,
			stripTypes: stripCompactTypes,
		});
		const wire = serializeRuntimeImage(image.runtime);
		const wirePath = path.join(directory, `${generation}-${name}.malw`);
		writeFileSync(wirePath, wire);
		return {
			href: pathToFileURL(entrypoint).href,
			wirePath: path.basename(wirePath),
			sha256: hash("sha256", wire, "hex"),
		};
	});
	const manifest = path.join(directory, `${generation}.json`);
	writeFileSync(manifest, JSON.stringify({ schema: 1, entries }));
	return manifest;
}

for (const compiled of [true, false]) {
	it(`retains overlapping same-href generations, descendants and transported URLs (${compiled ? "native" : "interpreted"})`, () => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-image-domains-"));
		try {
			const manifests = [
				writeDomain(directory, "first"),
				writeDomain(directory, "second"),
			];
			const binary = buildNativeBinary({
				fixture: path.join(fixtures, "main.mts"),
				mainFile: path.join(fixtures, "main.c"),
				name: `image-domains-${compiled ? "native" : "interpreted"}`,
				outDir: directory,
				compiled,
				config,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(
				invocation.executable,
				[...invocation.args, ...manifests],
				{
					encoding: "utf8",
					env: { ...process.env, ...STRESS_ENV },
					timeout: scaledNativeRunTimeoutMs(30_000, STRESS_ENV),
				},
			);
			if (result.status !== 0 && process.env.MAL_IMAGE_DOMAINS_EVIDENCE !== undefined) {
				const evidence = path.join(
					process.env.MAL_IMAGE_DOMAINS_EVIDENCE,
					compiled ? "native" : "interpreted",
				);
				mkdirSync(evidence, { recursive: true });
				cpSync(directory, evidence, { recursive: true });
				process.stderr.write(`Image domain failure evidence: ${evidence}\n`);
			}
			if (result.error !== undefined) throw result.error;
			expect(
				result.status,
				result.stderr || result.stdout || result.signal || "no exit status",
			).toBe(0);
			expect(result.stdout).toBe("image domains PASS\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 300_000);
}
