import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface ManifestTier {
	readonly tier: number;
	readonly id: string;
	readonly kind: string;
	readonly entries?: ReadonlyArray<string>;
}

interface CompilerScaleManifest {
	readonly schemaVersion: number;
	readonly syntheticScales: ReadonlyArray<number>;
	readonly tiers: ReadonlyArray<ManifestTier>;
}

const manifest = JSON.parse(
	readFileSync(path.resolve("bench/compiler-scale-manifest.json"), "utf8"),
) as CompilerScaleManifest;

describe("compiler scale manifest", () => {
	it("freezes the complete ordered complexity ladder", () => {
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.syntheticScales).toEqual([1, 3, 10]);
		expect(manifest.tiers.map(({ tier }) => tier)).toEqual(
			Array.from({ length: 14 }, (_, index) => index + 1),
		);
		expect(new Set(manifest.tiers.map(({ id }) => id)).size).toBe(14);
		expect(manifest.tiers.slice(0, 7).every(({ kind }) => kind === "synthetic")).toBe(
			true,
		);
		expect(manifest.tiers.at(-1)?.kind).toBe("command");
	});

	it("lists every Core module explicitly in the subtree fixture", () => {
		const coreFiles = readdirSync(path.resolve("src/compiler/core"), {
			withFileTypes: true,
		})
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map((entry) => `src/compiler/core/${entry.name}`)
			.sort();
		const aggregate = manifest.tiers.find(({ tier }) => tier === 12);

		expect([...(aggregate?.entries ?? [])].sort()).toEqual(coreFiles);
	});

	it("keeps every real fixture entry resolvable", () => {
		for (const tier of manifest.tiers) {
			for (const entry of tier.entries ?? []) {
				expect(
					readFileSync(path.resolve(entry)).length,
					`${tier.id} entry ${entry} is empty`,
				).toBeGreaterThan(0);
			}
		}
	});
});
