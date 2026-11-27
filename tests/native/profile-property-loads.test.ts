import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { parseCompilerCapture } from "../../src/profile-artifact.ts";
import {
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

it("counts the first property lookup and excludes subsequent getter and missing cache hits", () => {
	const directory = mkdtempSync(join(tmpdir(), "mal-profile-property-loads-"));
	try {
		const fixture = "tests/local/profile-property-loads.js";
		const config = resolveBuildConfig({
			engine: { eval: false, realms: false, temporal: false, intl: { enabled: false } },
		});
		const { binaryPath, programImage } = buildNativeBinaryResult({
			fixture,
			name: "profile-property-loads",
			outDir: directory,
			mainFile: HOST_MAIN,
			compiled: true,
			config,
			production: true,
			profileEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		const capture = join(directory, "capture.bin");
		expect(
			runToStdout(binaryPath, {
				env: {
					MAL_PROFILE_CAPTURE: capture,
					MAL_PROFILE_COMPILER: "1",
					MAL_PROFILE_IDENTITY: "a".repeat(64),
				},
			}),
		).toBe("300 50 50\n");

		const { bySite } = parseCompilerCapture(readFileSync(`${capture}.compiler`));
		const staticLoads = new Set(
			programImage.diagnostics.profileRemarks
				?.filter(({ code }) => code === "property.static-load")
				.map(({ siteId }) => siteId),
		);
		const lines = readFileSync(fixture, "utf8").split("\n");
		for (const property of ["ownValue", "inheritedValue", "missingValue"]) {
			const line = lines.findIndex((text) => text.includes(`.${property}`)) + 1;
			const counters = programImage
				.profiling!.sites.filter((site) => site.line === line && staticLoads.has(site.id))
				.map(({ id }) => bySite[id]!)
				.reduce(
					(total, site) => ({
						executions: total.executions + site.executions,
						fallbacks: total.fallbacks + site.fallbacks,
					}),
					{ executions: 0, fallbacks: 0 },
				);
			expect(counters, property).toEqual({ executions: 50, fallbacks: 1 });
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 300_000);
