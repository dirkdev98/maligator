import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { primordialInventoryDigest } from "../scripts/primordial-catalog-data.ts";
import { primordialInventoryModes } from "../scripts/primordial-inventory-config.ts";
import { capturePrimordialInventory } from "../scripts/primordial-inventory.ts";

const expected = JSON.parse(
	readFileSync("tests/fixtures/primordial-inventory/configurations.json", "utf8"),
) as {
	platform: string;
	arch: string;
	modes: Array<{ mode: string; sha256: string }>;
};

describe("native primordial installation matrix", () => {
	it.each(primordialInventoryModes)(
		"matches the audited %s descriptor graph without invoking getters",
		(mode) => {
			const directory = mkdtempSync(path.join(os.tmpdir(), "mal-primordials-"));
			try {
				const { phases } = capturePrimordialInventory(mode, directory);
				expect(
					{ platform: process.platform, arch: process.arch },
					"Regenerate the target-specific host descriptor audit on a new platform",
				).toEqual({ platform: expected.platform, arch: expected.arch });
				const digest = primordialInventoryDigest(phases);
				let mismatchMessage = "Descriptor audit digest changed";
				if (digest !== expected.modes.find((entry) => entry.mode === mode)?.sha256) {
					const evidence = path.resolve(".cache/primordial-inventory-failures");
					mkdirSync(evidence, { recursive: true });
					const file = path.join(evidence, `${mode}-${Date.now()}.json`);
					writeFileSync(file, JSON.stringify(phases));
					mismatchMessage = `Descriptor audit mismatch: ${file}`;
				}
				expect(digest, mismatchMessage).toBe(
					expected.modes.find((entry) => entry.mode === mode)?.sha256,
				);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
