import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isolatedToolsDirectory } from "../scripts/isolated-tools.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(path.join(os.tmpdir(), "mal-isolated-tools-"));
	vi.stubEnv("MALIGATOR_CACHE_DIR", path.join(directory, "cache"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

it("gives the same tool links the same directory across runs", () => {
	const cc = path.join(directory, "clang");
	const cargo = path.join(directory, "cargo");
	writeFileSync(cc, "");
	writeFileSync(cargo, "");

	const first = isolatedToolsDirectory([
		["cc", cc],
		["cargo", cargo],
	]);
	const again = isolatedToolsDirectory([
		["cc", cc],
		["cargo", cargo],
	]);
	const other = isolatedToolsDirectory([["cc", cc]]);

	expect(again).toBe(first);
	expect(other).not.toBe(first);
	expect(readlinkSync(path.join(first, "cc"))).toBe(cc);
	expect(readlinkSync(path.join(first, "cargo"))).toBe(cargo);
});
