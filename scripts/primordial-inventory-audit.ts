import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import { primordialInventoryDigest } from "./primordial-catalog-data.ts";
import {
	primordialInventoryConfig,
	primordialInventoryModes,
} from "./primordial-inventory-config.ts";
import type { PrimordialInventoryPhase } from "./primordial-inventory-data.ts";
import type { VerificationSource } from "./verification-source.ts";

export interface PrimordialInventoryTarget {
	platform: string;
	arch: string;
}

export interface PrimordialInventoryMetadata extends PrimordialInventoryTarget {
	schemaVersion: 2;
	mode: string;
	config: ResolvedBuildConfig;
	source: VerificationSource;
	phaseDigest: string;
}

export interface PrimordialInventoryModeAudit {
	mode: string;
	sha256: string;
	phases: Array<{
		phase: string;
		nodes: number;
		descriptors: number;
		repeatedOwnKeys: PrimordialInventoryPhase["repeatedOwnKeys"];
	}>;
}

export interface PrimordialTargetAudit extends PrimordialInventoryTarget {
	modes: Array<PrimordialInventoryModeAudit>;
	source?: VerificationSource;
}

export interface PrimordialInventoryConfigurations {
	catalogTarget: PrimordialInventoryTarget;
	pendingModes: Array<string>;
	pendingAvailability?: string;
	audits: Array<PrimordialTargetAudit>;
	availability: Array<[string, { string: string } | { symbol: string }, Array<string>]>;
}

export interface PrimordialInventoryCapture {
	mode: string;
	phases: Array<PrimordialInventoryPhase>;
	metadata: PrimordialInventoryMetadata;
}

function sameTarget(left: PrimordialInventoryTarget, right: PrimordialInventoryTarget) {
	return left.platform === right.platform && left.arch === right.arch;
}

function validTarget(target: PrimordialInventoryTarget | undefined) {
	return (
		target !== undefined &&
		typeof target.platform === "string" &&
		target.platform.length > 0 &&
		typeof target.arch === "string" &&
		target.arch.length > 0
	);
}

const sha256 = /^[a-f0-9]{64}$/;

export function readPrimordialInventoryConfigurations(
	file: string,
): PrimordialInventoryConfigurations {
	const configurations = JSON.parse(
		readFileSync(file, "utf8"),
	) as PrimordialInventoryConfigurations;
	if (
		!validTarget(configurations.catalogTarget) ||
		!Array.isArray(configurations.audits) ||
		!Array.isArray(configurations.pendingModes) ||
		!Array.isArray(configurations.availability)
	)
		throw new Error("Invalid target-indexed primordial inventory configurations");
	const targets = new Set<string>();
	for (const audit of configurations.audits) {
		const target = JSON.stringify([audit.platform, audit.arch]);
		if (!validTarget(audit) || targets.has(target) || !Array.isArray(audit.modes))
			throw new Error("Invalid or duplicate primordial inventory target audit");
		targets.add(target);
		const modes = new Set<string>();
		for (const row of audit.modes) {
			if (
				!primordialInventoryModes.includes(row.mode) ||
				modes.has(row.mode) ||
				!sha256.test(row.sha256) ||
				!Array.isArray(row.phases)
			)
				throw new Error("Invalid or duplicate primordial inventory mode audit");
			modes.add(row.mode);
		}
	}
	return configurations;
}

export function requirePrimordialInventoryAudit(
	configurations: PrimordialInventoryConfigurations,
	target: PrimordialInventoryTarget,
): PrimordialTargetAudit {
	const audit = configurations.audits.find((candidate) => sameTarget(candidate, target));
	if (audit === undefined)
		throw new Error(
			`Missing primordial inventory audit for ${target.platform}/${target.arch}; capture and import this target first`,
		);
	const modes = new Set(audit.modes.map((row) => row.mode));
	if (
		modes.size !== primordialInventoryModes.length ||
		primordialInventoryModes.some((mode) => !modes.has(mode))
	)
		throw new Error(
			`Incomplete primordial inventory audit for ${target.platform}/${target.arch}`,
		);
	return audit;
}

export function readPrimordialInventoryCaptures(
	directory: string,
	modes: ReadonlyArray<string> = primordialInventoryModes,
): Array<PrimordialInventoryCapture> {
	if (
		modes.length === 0 ||
		new Set(modes).size !== modes.length ||
		modes.some((mode) => !primordialInventoryModes.includes(mode))
	)
		throw new Error("Capture modes must be valid and unique");
	const captures = modes.map((mode): PrimordialInventoryCapture => {
		const metadata = JSON.parse(
			readFileSync(path.join(directory, `inventory-${mode}-metadata.json`), "utf8"),
		) as PrimordialInventoryMetadata;
		const source = metadata.source;
		if (
			metadata.schemaVersion !== 2 ||
			metadata.mode !== mode ||
			!validTarget(metadata) ||
			source === undefined ||
			!sha256.test(source.digest) ||
			!(source.revision === null || /^[a-f0-9]{40}$/.test(source.revision)) ||
			typeof source.dirty !== "boolean" ||
			!Number.isSafeInteger(source.files) ||
			source.files <= 0
		)
			throw new Error(`Invalid capture metadata for ${mode}`);
		if (
			!isDeepStrictEqual(
				metadata.config,
				JSON.parse(JSON.stringify(primordialInventoryConfig(mode))),
			)
		)
			throw new Error(`Capture configuration mismatch for ${mode}`);
		const phases = JSON.parse(
			readFileSync(path.join(directory, `inventory-${mode}.json`), "utf8"),
		) as Array<PrimordialInventoryPhase>;
		if (
			!Array.isArray(phases) ||
			phases.length !== 2 ||
			phases[0]?.phase !== "language-initialized" ||
			phases[1]?.phase !== "host-installed" ||
			phases.some(
				(phase) =>
					!Array.isArray(phase.nodes) ||
					phase.nodes.length === 0 ||
					!Array.isArray(phase.roots) ||
					phase.roots.length === 0 ||
					!Array.isArray(phase.repeatedOwnKeys),
			)
		)
			throw new Error(`Incomplete capture phases for ${mode}`);
		if (primordialInventoryDigest(phases) !== metadata.phaseDigest)
			throw new Error(`Capture phase digest mismatch for ${mode}`);
		return { mode, phases, metadata };
	});
	const first = captures[0]!;
	for (const capture of captures.slice(1)) {
		if (!sameTarget(capture.metadata, first.metadata))
			throw new Error(`Mixed capture targets at ${capture.mode}`);
		if (!isDeepStrictEqual(capture.metadata.source, first.metadata.source))
			throw new Error(`Mixed capture sources at ${capture.mode}`);
	}
	return captures;
}

export function primordialInventoryAudit(
	captures: ReadonlyArray<PrimordialInventoryCapture>,
): PrimordialTargetAudit {
	const first = captures[0];
	if (first === undefined) throw new Error("An inventory capture is required");
	return {
		platform: first.metadata.platform,
		arch: first.metadata.arch,
		source: first.metadata.source,
		modes: captures.map(({ mode, phases, metadata }) => ({
			mode,
			sha256: metadata.phaseDigest,
			phases: phases.map((phase) => ({
				phase: phase.phase,
				nodes: phase.nodes.length,
				descriptors: phase.nodes.reduce((sum, node) => sum + node.descriptors.length, 0),
				repeatedOwnKeys: phase.repeatedOwnKeys,
			})),
		})),
	};
}

export function withPrimordialInventoryAudit(
	configurations: PrimordialInventoryConfigurations,
	audit: PrimordialTargetAudit,
): PrimordialInventoryConfigurations {
	const index = configurations.audits.findIndex((prior) => sameTarget(prior, audit));
	const audits = [...configurations.audits];
	if (index === -1) audits.push(audit);
	else audits[index] = audit;
	return { ...configurations, audits };
}

export function changedPrimordialInventoryModes(
	configurations: PrimordialInventoryConfigurations,
	audit: PrimordialTargetAudit,
): Array<string> {
	const recorded = configurations.audits.find((prior) => sameTarget(prior, audit));
	return audit.modes
		.filter(
			(row) =>
				recorded?.modes.find((prior) => prior.mode === row.mode)?.sha256 !== row.sha256,
		)
		.map((row) => row.mode);
}

export function importPrimordialInventoryAudit(
	directory: string,
	configurationsFile: string,
): PrimordialTargetAudit {
	const configurations = readPrimordialInventoryConfigurations(configurationsFile);
	const captures = readPrimordialInventoryCaptures(directory);
	const audit = primordialInventoryAudit(captures);
	writeFileSync(
		configurationsFile,
		`${JSON.stringify(withPrimordialInventoryAudit(configurations, audit))}\n`,
	);
	return audit;
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const check = process.argv[2] === "--check";
	const [directory, configurationsFile, ...extra] = process.argv.slice(check ? 3 : 2);
	if (directory === undefined || extra.length > 0)
		throw new Error(
			"Usage: node scripts/primordial-inventory-audit.ts [--check] CAPTURE_DIR [CONFIGURATIONS_FILE]",
		);
	const file = path.resolve(
		configurationsFile ?? "tests/fixtures/primordial-inventory/configurations.json",
	);
	if (check) {
		const audit = primordialInventoryAudit(
			readPrimordialInventoryCaptures(path.resolve(directory)),
		);
		const changedModes = changedPrimordialInventoryModes(
			readPrimordialInventoryConfigurations(file),
			audit,
		);
		console.log(
			JSON.stringify({ platform: audit.platform, arch: audit.arch, changedModes }),
		);
	} else {
		const audit = importPrimordialInventoryAudit(path.resolve(directory), file);
		console.log(`${file}: ${audit.platform}/${audit.arch}, ${audit.modes.length} modes`);
	}
}
