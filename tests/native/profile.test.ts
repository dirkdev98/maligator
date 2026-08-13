import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary } from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-profile-"));

describe("production profile recorder", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/profile.js",
			name: "profile-recorder",
			compiled: true,
			profileEnabled: true,
			outDir: directory,
		});
	});

	it("captures bounded logical CPU stacks in the versioned raw format", () => {
		const capture = path.join(directory, "capture.bin");
		const result = spawnSync(binary, [], {
			env: { ...process.env, MAL_PROFILE_CAPTURE: capture },
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(existsSync(capture)).toBe(true);
		const bytes = readFileSync(capture);
		expect(bytes.subarray(0, 8).toString()).toBe("MALPROF1");
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		expect(view.getUint32(8, true)).toBe(1);
		const recordCount = view.getUint32(12, true);
		const frameCount = view.getUint32(16, true);
		expect(recordCount).toBeGreaterThan(0);
		expect(frameCount).toBeGreaterThan(0);
		expect(view.getUint8(40)).toBe(1);
		expect(bytes.byteLength).toBe(40 + recordCount * 40 + frameCount * 8);
	});
});
