import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
	withServer,
} from "../../src/test-harness.ts";
const fixture = "tests/local/http-header-ownership.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-http-header-ownership-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let expected: string;
beforeAll(() => {
	expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
		encoding: "utf8",
		timeout: 15000,
	});
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "http-header-ownership",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
	});
});
it.each(["compiled", "interpreted"] as const)(
	"preserves incoming header values and descriptors after collection with %s execution",
	(backend) => {
		const environments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		)
			? [{}]
			: [{}, STRESS_ENV];
		for (const env of environments)
			expect(
				runToStdout(pair[backend], {
					env: { ...env, MAL_HOST_GC: "1" },
					timeoutMs: 30000,
				}),
			).toBe(expected);
	},
);
function request(url: string, headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		get(url, { agent: false, headers }, (response) => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				text += chunk;
			});
			response.on("end", () => resolve(text));
			response.on("error", reject);
		}).on("error", reject);
	});
}
it("releases unretained header names after repeated request batches", async () => {
	await withServer(
		pair.compiled,
		{ HEADER_MEMORY_SERVER: "1", MAL_HOST_GC: "1" },
		async (url) => {
			const batchSize = 256;
			const fieldCount = 8;
			const growth: Array<number> = [];
			for (let batch = 0; batch < 3; batch++) {
				for (let i = 0; i < batchSize; i++) {
					const headers: Record<string, string> = {};
					for (let field = 0; field < fieldCount; field++)
						headers[`x-batch-${batch}-request-${i}-field-${field}`] = "value";
					await request(url, headers);
				}
				const memory: unknown = JSON.parse(await request(`${url}/memory`));
				if (
					typeof memory !== "object" ||
					memory === null ||
					!("heapUsed" in memory) ||
					!("external" in memory) ||
					typeof memory.heapUsed !== "number" ||
					typeof memory.external !== "number"
				)
					throw new Error("Invalid memory report");
				growth.push(memory.heapUsed + memory.external);
			}
			expect(
				growth[2]! - growth[0]!,
				`retained bytes across batches: ${growth.join(", ")}`,
			).toBeLessThan(batchSize * fieldCount * 32);
		},
	);
}, 30000);
