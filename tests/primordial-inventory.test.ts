import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { primordialInventoryDigest } from "../scripts/primordial-catalog-data.ts";
import {
	readPrimordialInventoryConfigurations,
	requirePrimordialInventoryAudit,
} from "../scripts/primordial-inventory-audit.ts";
import { primordialInventoryModes } from "../scripts/primordial-inventory-config.ts";
import { capturePrimordialInventory } from "../scripts/primordial-inventory.ts";

const expected = requirePrimordialInventoryAudit(
	readPrimordialInventoryConfigurations(
		"tests/fixtures/primordial-inventory/configurations.json",
	),
	{ platform: process.platform, arch: process.arch },
);

describe("native primordial installation matrix", () => {
	it.each(primordialInventoryModes)(
		"matches the audited %s descriptor graph without invoking getters",
		(mode) => {
			const directory = mkdtempSync(path.join(os.tmpdir(), "mal-primordials-"));
			try {
				const { phases } = capturePrimordialInventory(mode, directory);
				const digest = primordialInventoryDigest(phases);
				let mismatchMessage = "Descriptor audit digest changed";
				if (digest !== expected.modes.find((entry) => entry.mode === mode)?.sha256) {
					const evidence = path.resolve(
						".cache/primordial-inventory-failures",
						`${process.platform}-${process.arch}`,
						`${mode}-${Date.now()}`,
					);
					mkdirSync(evidence, { recursive: true });
					const file = path.join(evidence, `inventory-${mode}.json`);
					writeFileSync(file, JSON.stringify(phases));
					for (const suffix of [".jsonl", "-metadata.json", "-config.json"])
						copyFileSync(
							path.join(directory, `inventory-${mode}${suffix}`),
							path.join(evidence, `inventory-${mode}${suffix}`),
						);
					mismatchMessage = `Descriptor audit mismatch: ${file}`;
				}
				expect(digest, mismatchMessage).toBe(
					expected.modes.find((entry) => entry.mode === mode)?.sha256,
				);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
		1_200_000,
	);
});
