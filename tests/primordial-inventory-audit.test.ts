import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { primordialInventoryDigest } from "../scripts/primordial-catalog-data.ts";
import {
	importPrimordialInventoryAudit,
	readPrimordialInventoryConfigurations,
	requirePrimordialInventoryAudit,
} from "../scripts/primordial-inventory-audit.ts";
import type {
	PrimordialInventoryConfigurations,
	PrimordialInventoryMetadata,
	PrimordialInventorySource,
} from "../scripts/primordial-inventory-audit.ts";
import {
	primordialInventoryConfig,
	primordialInventoryModes,
} from "../scripts/primordial-inventory-config.ts";
import type { PrimordialInventoryPhase } from "../scripts/primordial-inventory-data.ts";

const source: PrimordialInventorySource = {
	revision: "a".repeat(40),
	digest: "b".repeat(64),
	dirty: false,
	files: 12,
	installerSha256: "c".repeat(64),
};
const phases: Array<PrimordialInventoryPhase> = [
	"language-initialized",
	"host-installed",
].map((phase) => ({
	phase,
	roots: [{ name: "globalThis", value: { string: "captured fixture" } }],
	nodes: [{ id: "globalThis", kind: "object", aliases: ["globalThis"], descriptors: [] }],
	repeatedOwnKeys: [],
}));
const historical: PrimordialInventoryConfigurations = {
	catalogTarget: { platform: "darwin", arch: "arm64" },
	pendingModes: ["minimal"],
	pendingAvailability: "last-captured",
	audits: [
		{
			platform: "darwin",
			arch: "arm64",
			modes: primordialInventoryModes.map((mode) => ({
				mode,
				sha256: "d".repeat(64),
				phases: [],
			})),
		},
	],
	availability: [["Object", { string: "keys" }, ["full"]]],
};

function fixture(run: (directory: string, configurations: string) => void) {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-primordial-audit-"));
	try {
		const configurations = path.join(directory, "configurations.json");
		writeFileSync(configurations, JSON.stringify(historical));
		for (const mode of primordialInventoryModes) {
			const metadata: PrimordialInventoryMetadata = {
				schemaVersion: 1,
				platform: "linux",
				arch: "x64",
				mode,
				config: primordialInventoryConfig(mode),
				source,
				phaseDigest: primordialInventoryDigest(phases),
			};
			writeFileSync(
				path.join(directory, `inventory-${mode}-metadata.json`),
				JSON.stringify(metadata),
			);
			writeFileSync(
				path.join(directory, `inventory-${mode}.json`),
				JSON.stringify(phases),
			);
		}
		run(directory, configurations);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function changeMetadata(
	directory: string,
	change: (metadata: PrimordialInventoryMetadata) => void,
) {
	const file = path.join(directory, "inventory-full-metadata.json");
	const metadata = JSON.parse(readFileSync(file, "utf8")) as PrimordialInventoryMetadata;
	change(metadata);
	writeFileSync(file, JSON.stringify(metadata));
}

function hostCertificatePhase(count: number): PrimordialInventoryPhase {
	const certificates = Array.from({ length: count }, (_, index) => ({
		key: { string: String(index) },
		flags: 2,
		value: { string: `certificate ${index}` },
	}));
	return {
		phase: "host-installed",
		repeatedOwnKeys: [],
		roots: [],
		nodes: [
			{
				id: "%mal_host_install_node_tls:rootCertificates%",
				kind: "object",
				aliases: [],
				descriptors: [
					...certificates,
					{ key: { string: "length" }, flags: 2, value: { number: count } },
				],
			},
		],
	} as unknown as PrimordialInventoryPhase;
}

describe("primordial inventory contract", () => {
	it("leaves the elements of host-installed values out of the digest", () => {
		expect(primordialInventoryDigest([hostCertificatePhase(121)])).toBe(
			primordialInventoryDigest([hostCertificatePhase(122)]),
		);
	});
});

describe("target-specific primordial descriptor audits", () => {
	it("imports all modes under their captured target without replacing catalog provenance or historical audits", () => {
		fixture((directory, file) => {
			const audit = importPrimordialInventoryAudit(directory, file);
			const result = readPrimordialInventoryConfigurations(file);
			expect(audit).toMatchObject({ platform: "linux", arch: "x64", source });
			expect(audit.modes.map((row) => row.mode)).toEqual(primordialInventoryModes);
			expect(
				audit.modes.every((row) => row.sha256 === primordialInventoryDigest(phases)),
			).toBe(true);
			expect(result).toEqual({ ...historical, audits: [...historical.audits, audit] });
			expect(
				requirePrimordialInventoryAudit(result, { platform: "darwin", arch: "arm64" }),
			).toEqual(historical.audits[0]);
		});
	});

	it("replaces only the matching target audit when a fresh complete capture is imported", () => {
		fixture((directory, file) => {
			const original = importPrimordialInventoryAudit(directory, file);
			for (const mode of primordialInventoryModes) {
				const metadataFile = path.join(directory, `inventory-${mode}-metadata.json`);
				const metadata = JSON.parse(
					readFileSync(metadataFile, "utf8"),
				) as PrimordialInventoryMetadata;
				metadata.source.digest = "e".repeat(64);
				writeFileSync(metadataFile, JSON.stringify(metadata));
			}
			const fresh = importPrimordialInventoryAudit(directory, file);
			expect(fresh.source?.digest).not.toBe(original.source?.digest);
			expect(readPrimordialInventoryConfigurations(file)).toEqual({
				...historical,
				audits: [...historical.audits, fresh],
			});
		});
	});

	it.each([
		[
			"missing mode",
			(directory: string) => rmSync(path.join(directory, "inventory-minimal.json")),
		],
		[
			"missing metadata",
			(directory: string) =>
				rmSync(path.join(directory, "inventory-minimal-metadata.json")),
		],
		[
			"mixed target",
			(directory: string) =>
				changeMetadata(directory, (metadata) => {
					metadata.arch = "arm64";
				}),
		],
		[
			"mixed source",
			(directory: string) =>
				changeMetadata(directory, (metadata) => {
					metadata.source.digest = "e".repeat(64);
				}),
		],
		[
			"mixed installers",
			(directory: string) =>
				changeMetadata(directory, (metadata) => {
					metadata.source.installerSha256 = "f".repeat(64);
				}),
		],
		[
			"wrong mode",
			(directory: string) =>
				changeMetadata(directory, (metadata) => {
					metadata.mode = "minimal";
				}),
		],
		[
			"wrong configuration",
			(directory: string) =>
				changeMetadata(directory, (metadata) => {
					metadata.config.engine.realms = false;
				}),
		],
		[
			"changed phases",
			(directory: string) =>
				writeFileSync(
					path.join(directory, "inventory-full.json"),
					JSON.stringify(phases.map((phase) => ({ ...phase, roots: [] }))),
				),
		],
		[
			"missing phase",
			(directory: string) =>
				writeFileSync(
					path.join(directory, "inventory-full.json"),
					JSON.stringify(phases.slice(1)),
				),
		],
		[
			"duplicate phase",
			(directory: string) =>
				writeFileSync(
					path.join(directory, "inventory-full.json"),
					JSON.stringify([phases[0], phases[0]]),
				),
		],
		[
			"empty phases",
			(directory: string) =>
				writeFileSync(path.join(directory, "inventory-full.json"), "[]"),
		],
		[
			"empty descriptor graphs",
			(directory: string) => {
				const empty = phases.map((phase) => ({ ...phase, nodes: [] }));
				writeFileSync(path.join(directory, "inventory-full.json"), JSON.stringify(empty));
				changeMetadata(directory, (metadata) => {
					metadata.phaseDigest = primordialInventoryDigest(empty);
				});
			},
		],
	] as const)("rejects %s before writing the audit", (_, damage) => {
		fixture((directory, file) => {
			const original = readFileSync(file, "utf8");
			damage(directory);
			expect(() => importPrimordialInventoryAudit(directory, file)).toThrow();
			expect(readFileSync(file, "utf8")).toBe(original);
		});
	});

	it("rejects missing and incomplete targets without native capture", () => {
		expect(() =>
			requirePrimordialInventoryAudit(historical, { platform: "linux", arch: "x64" }),
		).toThrow("Missing primordial inventory audit for linux/x64");
		expect(() =>
			requirePrimordialInventoryAudit(
				{ ...historical, audits: [{ ...historical.audits[0]!, modes: [] }] },
				historical.catalogTarget,
			),
		).toThrow("Incomplete primordial inventory audit");
	});

	it("does not accept the former single-target configuration schema", () => {
		fixture((_, file) => {
			writeFileSync(file, JSON.stringify({ ...historical.audits[0], availability: [] }));
			expect(() => readPrimordialInventoryConfigurations(file)).toThrow(
				"Invalid target-indexed",
			);
		});
	});

	it("rejects historical installer captures before catalog generation can write outputs", () => {
		fixture((directory, file) => {
			mkdirSync(path.join(directory, "runtime/src"), { recursive: true });
			writeFileSync(
				path.join(directory, "runtime/src/fixture.c"),
				"void mal_intrinsic_define(void);\n",
			);
			mkdirSync(path.join(directory, "src/compiler/shared"), { recursive: true });
			const catalog = path.join(
				directory,
				"src/compiler/shared/primordial-catalog-data.ts",
			);
			writeFileSync(catalog, "unchanged catalog\n");
			const before = readFileSync(file, "utf8");
			const result = spawnSync(
				process.execPath,
				[path.resolve("scripts/generate-primordial-catalog.ts"), directory],
				{
					cwd: directory,
					encoding: "utf8",
					timeout: 10_000,
				},
			);
			expect(result.status, result.stderr).toBe(1);
			expect(result.stderr).toContain(
				"Captured primordial installer inventory differs from current sources",
			);
			expect(readFileSync(catalog, "utf8")).toBe("unchanged catalog\n");
			expect(readFileSync(file, "utf8")).toBe(before);
		});
	});
});
