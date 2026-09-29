import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { compileNativeMicroProgram } from "../scripts/native-micro-frontend.ts";
import { resolveBuildConfig } from "../src/build-config.ts";

it("compiles the complete frozen module graph with the product closure certificate", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-micro-frontend-"));
	try {
		writeFileSync(path.join(directory, "helper.mjs"), "export const answer = 42;");
		const fixture = path.join(directory, "entry.mjs");
		writeFileSync(
			fixture,
			'import { answer } from "./helper.mjs"; globalThis.answer = answer;',
		);
		const { evidence, programImage } = await compileNativeMicroProgram(
			path.resolve(import.meta.dirname, ".."),
			fixture,
			resolveBuildConfig({ engine: { eval: false, realms: false } }),
		);
		expect(evidence.closure.sourceClosure.kind).toBe("known");
		expect(evidence.cache).toBe("disabled");
		expect(programImage.runtime.entrypointPath).toBe(fixture);
		expect(programImage.runtime.functions.length).toBeGreaterThan(0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("does not claim closure when the configured program admits dynamic source", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-micro-open-"));
	try {
		const fixture = path.join(directory, "entry.mjs");
		writeFileSync(fixture, "globalThis.answer = 42;");
		const { evidence } = await compileNativeMicroProgram(
			path.resolve(import.meta.dirname, ".."),
			fixture,
			resolveBuildConfig({ engine: { eval: true } }),
		);
		expect(evidence.closure.sourceClosure.kind).not.toBe("known");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
