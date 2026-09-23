import { hash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { compilerProducerIdentity } from "./compiler-cache-identity.ts";
import type { CoreFunctionId } from "./compiler/core/core-ir.ts";
import type { CorePgoInput, CorePgoQueryCoverage } from "./compiler/core/core-pgo.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";
import { readProfileCpuEvidence } from "./profile-artifact.ts";
import {
	SourceProfileIdentities,
	canonicalProfileJson,
} from "./source-profile-identity.ts";
import type {
	ProfileFunctionIdentity,
	ProfileCallIdentity,
} from "./source-profile-identity.ts";

const MAX_COUNTERS = 1_048_576;
const MAX_COUNT = 0xffff_ffff_ffff_ffffn;
const TARGET_SLOTS = 4;
const TARGET_SITE_BYTES = 4 + TARGET_SLOTS * 12;
const MAX_CAPTURE_MEMORY = 64 * 1024 * 1024;

function captureMemoryBytes(functions: number, calls: number): number {
	return (functions + calls) * 8 + calls * 72;
}

export interface PreparedPgo {
	schema: 2;
	semantics: 2;
	producer: string;
	semanticKey: string;
	image: string;
	functions: Array<{
		name: string;
		generator: boolean;
		identity: ProfileFunctionIdentity;
	}>;
	calls: Array<{
		kind: string;
		file: string;
		line: number;
		column: number;
		instrumented: boolean;
		targetInstrumented: boolean;
		identity: ProfileCallIdentity;
	}>;
}

export interface PgoCaptureManifest {
	schema: 2;
	runId: string;
	workload: string;
	status: "complete" | "incomplete";
	prepared: PreparedPgo;
	captureIdentity: string;
	payloadDigest?: string;
	overflow?: boolean;
	reason?: string;
}

export interface MergedPgoProfile {
	schema: 3;
	semantics: 2;
	semanticKey: string;
	digest: string;
	overflow: boolean;
	runs: Array<{
		runId: string;
		workload: string;
		producer: string;
		image: string;
		captureIdentity: string;
		payloadDigest: string;
	}>;
	cpuCaptures: Array<{
		captureId: string;
		workload: string;
		producer: string;
		image: string;
		captureIdentity: string;
		payloadDigest: string;
		intervalUs: number;
		totalSamples: number;
		unattributedSamples: number;
		ambiguousSamples: number;
		functions: Array<{ origin: string; revision: string; samples: string }>;
	}>;
	cpuFunctions: Array<{
		origin: string;
		revision: string;
		samples: string;
		estimatedCpuNs: string;
	}>;
	functions: Array<{ origin: string; revision: string; count: string }>;
	calls: Array<{ key: string; count: string }>;
	targets: Array<{ key: string; origin: string; revision: string; count: string }>;
	targetUnknownCalls: Array<string>;
	coverage: {
		unknownFunctions: number;
		unknownCalls: number;
		uninstrumentedCalls: number;
		observedZeroFunctions: number;
		observedZeroCalls: number;
		incompleteTargetCalls: number;
	};
}

function digest(value: unknown): string {
	return hash("sha256", canonicalProfileJson(value), "hex");
}

export function pgoSemanticIdentity(config: ResolvedBuildConfig): string {
	return digest({ engine: config.engine, surface: config.surface });
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${randomUUID()}`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function preparePgoTraining(
	binary: string,
	image: ProgramImage,
	semanticKey: string,
): PreparedPgo {
	if (image.diagnostics.pgoTraining !== true)
		throw new Error("PGO requires a training image");
	const sites = image.diagnostics.sourceCallSites ?? [];
	if (
		image.runtime.functions.length + sites.length > MAX_COUNTERS ||
		captureMemoryBytes(image.runtime.functions.length, sites.length) > MAX_CAPTURE_MEMORY
	)
		throw new Error("PGO counter limit exceeded");
	const instrumented = new Set<number>();
	const targetInstrumented = new Set<number>();
	const targetUnsupported = new Set<number>();
	for (const fn of image.runtime.functions)
		for (const instruction of fn.instructions) {
			if (instruction.opcode !== "PGO_CALL") continue;
			if (
				!Number.isSafeInteger(instruction.site) ||
				instruction.site < 0 ||
				instruction.site >= sites.length
			)
				throw new Error("PGO call marker is outside the source map");
			instrumented.add(instruction.site);
			if (instruction.callee < 0) targetUnsupported.add(instruction.site);
			else {
				if (instruction.callee >= fn.registerCount)
					throw new Error("PGO callee marker is outside its function register file");
				targetInstrumented.add(instruction.site);
			}
		}
	const resolver = new SourceProfileIdentities();
	const prepared: PreparedPgo = {
		schema: 2,
		semantics: 2,
		producer: compilerProducerIdentity("pgo-training", 2),
		semanticKey,
		image: hash("sha256", readFileSync(binary), "hex"),
		functions: image.runtime.functions.map((fn, index) => ({
			name: String.fromCodePoint(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			),
			generator: fn.isGenerator,
			identity: resolver.functionIdentity(image.diagnostics.profileFunctions?.[index]),
		})),
		calls: sites.map((site, index) => ({
			kind: site.kind,
			file: site.file,
			line: site.line,
			column: site.column,
			instrumented: instrumented.has(index),
			targetInstrumented: targetInstrumented.has(index) && !targetUnsupported.has(index),
			identity: resolver.callIdentity(site),
		})),
	};
	writeJson(`${binary}.pgo.json`, prepared);
	return prepared;
}

export function createPgoCapture(
	prepared: PreparedPgo,
	workload: string,
	root = path.resolve(".cache/pgo/runs"),
) {
	if (workload.trim() === "") throw new Error("PGO workload name must be nonempty");
	const runId = randomUUID();
	const directory = path.join(root, runId);
	const captureIdentity = digest({ prepared, runId, workload });
	const manifest: PgoCaptureManifest = {
		schema: 2,
		runId,
		workload,
		status: "incomplete",
		prepared,
		captureIdentity,
	};
	writeJson(path.join(directory, "manifest.json"), manifest);
	return {
		directory,
		manifest,
		environment: {
			MAL_PGO_CAPTURE: path.join(directory, "counts.bin"),
			MAL_PGO_IDENTITY: captureIdentity,
			MAL_PGO_FUNCTIONS: String(prepared.functions.length),
			MAL_PGO_CALL_SITES: String(prepared.calls.length),
		},
	};
}

export function parsePgoCounts(bytes: Uint8Array) {
	if (bytes.length < 64) throw new Error("PGO payload is truncated");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		Buffer.from(bytes.subarray(0, 8)).toString() !== "MALPGO2\0" ||
		view.getUint32(8, true) !== 2 ||
		view.getUint32(12, true) !== 2
	)
		throw new Error("PGO payload schema or semantics mismatch");
	const functionCount = view.getUint32(16, true);
	const callCount = view.getUint32(20, true);
	const payloadFlags = view.getUint32(24, true);
	if (payloadFlags > 3 || view.getUint32(28, true) !== TARGET_SLOTS)
		throw new Error("PGO payload flags are invalid");
	if (
		functionCount + callCount > MAX_COUNTERS ||
		captureMemoryBytes(functionCount, callCount) > MAX_CAPTURE_MEMORY ||
		bytes.length !== 64 + (functionCount + callCount) * 8 + callCount * TARGET_SITE_BYTES
	)
		throw new Error("PGO payload counter length mismatch");
	const counts = Array.from({ length: functionCount + callCount }, (_, index) =>
		view.getBigUint64(64 + index * 8, true),
	);
	const targets = Array.from({ length: callCount }, (_, site) => {
		const offset = 64 + (functionCount + callCount) * 8 + site * TARGET_SITE_BYTES;
		const siteFlags = view.getUint32(offset, true);
		if (siteFlags > 1) throw new Error("PGO target table flags are invalid");
		const entries: Array<{ functionIndex: number; count: bigint }> = [];
		const seen = new Set<number>();
		let empty = false;
		for (let slot = 0; slot < TARGET_SLOTS; slot++) {
			const at = offset + 4 + slot * 12;
			const functionIndex = view.getUint32(at, true);
			const count = view.getBigUint64(at + 4, true);
			if (functionIndex === 0xffff_ffff && count === 0n) {
				empty = true;
				continue;
			}
			if (
				empty ||
				functionIndex >= functionCount ||
				count === 0n ||
				seen.has(functionIndex)
			)
				throw new Error("PGO target table has invalid or duplicate entries");
			seen.add(functionIndex);
			entries.push({ functionIndex, count });
		}
		if (
			(payloadFlags & 1) === 0 &&
			entries.reduce((sum, entry) => sum + entry.count, 0n) >
				counts[functionCount + site]!
		)
			throw new Error("PGO target count exceeds source attempts");
		return { truncated: siteFlags === 1, entries };
	});
	return {
		captureIdentity: Buffer.from(bytes.subarray(32, 64)).toString("hex"),
		overflow: (payloadFlags & 1) !== 0,
		invalid: (payloadFlags & 2) !== 0,
		functions: counts.slice(0, functionCount),
		calls: counts.slice(functionCount),
		targets,
	};
}

function validatePrepared(prepared: PreparedPgo): void {
	const hex = (value: unknown) =>
		typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
	if (
		prepared.schema !== 2 ||
		prepared.semantics !== 2 ||
		!hex(prepared.semanticKey) ||
		!hex(prepared.image) ||
		typeof prepared.producer !== "string" ||
		!Array.isArray(prepared.functions) ||
		!Array.isArray(prepared.calls) ||
		prepared.functions.length + prepared.calls.length > MAX_COUNTERS ||
		captureMemoryBytes(prepared.functions.length, prepared.calls.length) >
			MAX_CAPTURE_MEMORY
	)
		throw new Error("Invalid PGO source map");
	for (const fn of prepared.functions) {
		if (typeof fn.name !== "string" || typeof fn.generator !== "boolean")
			throw new Error("Invalid PGO function");
		const identity = fn.identity;
		if (identity.status === "known" || identity.status === "shared") {
			if (
				!hex(identity.origin) ||
				!hex(identity.revision) ||
				!["portable", "checkout"].includes(identity.portability)
			)
				throw new Error("Invalid PGO function identity");
		} else if (
			(identity.status !== "unknown" && identity.status !== "ambiguous") ||
			typeof identity.reason !== "string"
		)
			throw new Error("Invalid PGO function identity");
	}
	for (const site of prepared.calls) {
		if (
			typeof site.instrumented !== "boolean" ||
			typeof site.targetInstrumented !== "boolean" ||
			(site.targetInstrumented && !site.instrumented) ||
			typeof site.kind !== "string" ||
			typeof site.file !== "string" ||
			!Number.isSafeInteger(site.line) ||
			!Number.isSafeInteger(site.column)
		)
			throw new Error("Invalid PGO call site");
		const identity = site.identity;
		if (identity.status === "known") {
			if (!hex(identity.key) || !hex(identity.owner) || !hex(identity.revision))
				throw new Error("Invalid PGO call identity");
		} else if (
			(identity.status !== "unknown" && identity.status !== "ambiguous") ||
			typeof identity.reason !== "string"
		)
			throw new Error("Invalid PGO call identity");
	}
}

export function readPreparedPgoTraining(binary: string): PreparedPgo {
	const prepared = JSON.parse(readFileSync(`${binary}.pgo.json`, "utf8")) as PreparedPgo;
	validatePrepared(prepared);
	if (prepared.image !== hash("sha256", readFileSync(binary), "hex"))
		throw new Error("PGO training binary does not match its source map");
	return prepared;
}

function readCounts(directory: string, manifest: PgoCaptureManifest) {
	validatePrepared(manifest.prepared);
	if (
		typeof manifest.runId !== "string" ||
		manifest.runId.length === 0 ||
		typeof manifest.workload !== "string" ||
		manifest.workload.trim().length === 0
	)
		throw new Error("Invalid PGO run identity");
	if (
		manifest.schema !== 2 ||
		manifest.prepared.schema !== 2 ||
		manifest.prepared.semantics !== 2
	)
		throw new Error("PGO manifest schema or semantics mismatch");
	if (
		manifest.captureIdentity !==
		digest({
			prepared: manifest.prepared,
			runId: manifest.runId,
			workload: manifest.workload,
		})
	)
		throw new Error("PGO manifest identity mismatch");
	const bytes = readFileSync(path.join(directory, "counts.bin"));
	const payloadDigest = hash("sha256", bytes, "hex");
	if (manifest.payloadDigest !== undefined && manifest.payloadDigest !== payloadDigest)
		throw new Error("PGO payload checksum mismatch");
	const counts = parsePgoCounts(bytes);
	if (
		counts.captureIdentity !== manifest.captureIdentity ||
		counts.functions.length !== manifest.prepared.functions.length ||
		counts.calls.length !== manifest.prepared.calls.length
	)
		throw new Error("PGO payload does not match its source map");
	if (counts.invalid)
		throw new Error("PGO encountered an unsupported runtime image or invocation path");
	return { ...counts, payloadDigest };
}

export function finalizePgoCapture(
	capture: ReturnType<typeof createPgoCapture>,
	successful: boolean,
): PgoCaptureManifest {
	let manifest: PgoCaptureManifest = { ...capture.manifest };
	try {
		if (!successful) throw new Error("Training process did not complete successfully");
		const counts = readCounts(capture.directory, manifest);
		manifest = {
			...manifest,
			status: "complete",
			payloadDigest: counts.payloadDigest,
			overflow: counts.overflow,
		};
		return manifest;
	} catch (error) {
		manifest = {
			...manifest,
			status: "incomplete",
			reason: error instanceof Error ? error.message : String(error),
		};
		throw error;
	} finally {
		writeJson(path.join(capture.directory, "manifest.json"), manifest);
	}
}

export function mergePgoCaptures(
	inputs: ReadonlyArray<string>,
	output?: string,
	options: { cpuProfiles?: ReadonlyArray<{ workload: string; directory: string }> } = {},
): { profile: MergedPgoProfile; path: string } {
	if (inputs.length === 0) throw new Error("PGO merge needs explicit captures");
	const captures = new Map<
		string,
		{ manifest: PgoCaptureManifest; counts: ReturnType<typeof readCounts> }
	>();
	for (const input of inputs) {
		const file = input.endsWith(".json") ? input : path.join(input, "manifest.json");
		const manifest = JSON.parse(readFileSync(file, "utf8")) as PgoCaptureManifest;
		if (manifest.status !== "complete" || manifest.payloadDigest === undefined)
			throw new Error("PGO merge rejects incomplete captures");
		const counts = readCounts(path.dirname(file), manifest);
		const existing = captures.get(manifest.runId);
		if (
			existing !== undefined &&
			(existing.manifest.captureIdentity !== manifest.captureIdentity ||
				existing.counts.payloadDigest !== counts.payloadDigest)
		)
			throw new Error("PGO merge rejects conflicting duplicate run IDs");
		captures.set(manifest.runId, { manifest, counts });
	}
	const ordered = [...captures.values()].sort((a, b) =>
		a.manifest.runId.localeCompare(b.manifest.runId),
	);
	const semanticKey = ordered[0]!.manifest.prepared.semanticKey;
	const cpuCaptures = new Map<string, ReturnType<typeof readProfileCpuEvidence>>();
	for (const input of options.cpuProfiles ?? []) {
		const evidence = readProfileCpuEvidence(input.directory, input.workload);
		if (evidence.semanticKey !== semanticKey)
			throw new Error("PGO CPU profile semantic configuration mismatch");
		const prior = cpuCaptures.get(evidence.captureId);
		if (
			prior !== undefined &&
			(prior.payloadDigest !== evidence.payloadDigest ||
				prior.captureIdentity !== evidence.captureIdentity ||
				prior.workload !== evidence.workload)
		)
			throw new Error("PGO merge rejects conflicting duplicate CPU captures");
		cpuCaptures.set(evidence.captureId, evidence);
	}
	const orderedCpu = [...cpuCaptures.values()].sort((a, b) =>
		a.captureId.localeCompare(b.captureId),
	);
	const cpuFunctions = new Map<
		string,
		{ origin: string; revision: string; samples: bigint; estimatedCpuNs: bigint }
	>();
	for (const evidence of orderedCpu) {
		for (const row of evidence.functions) {
			const key = `${row.origin}:${row.revision}`;
			const prior = cpuFunctions.get(key);
			cpuFunctions.set(key, {
				origin: row.origin,
				revision: row.revision,
				samples: (prior?.samples ?? 0n) + BigInt(row.samples),
				estimatedCpuNs: (prior?.estimatedCpuNs ?? 0n) + BigInt(row.estimatedCpuNs),
			});
		}
	}
	const functions = new Map<
		string,
		{ origin: string; revision: string; count: bigint }
	>();
	const calls = new Map<string, bigint>();
	const targets = new Map<
		string,
		{ key: string; origin: string; revision: string; count: bigint }
	>();
	const targetUnknownCalls = new Set<string>();
	const coverage = {
		unknownFunctions: 0,
		unknownCalls: 0,
		uninstrumentedCalls: 0,
		observedZeroFunctions: 0,
		observedZeroCalls: 0,
		incompleteTargetCalls: 0,
	};
	let overflow = false;
	const add = (left: bigint, right: bigint) => {
		if (left + right <= MAX_COUNT) return left + right;
		overflow = true;
		return MAX_COUNT;
	};
	for (const { manifest, counts } of ordered) {
		if (manifest.prepared.semanticKey !== semanticKey)
			throw new Error("PGO semantic configuration mismatch");
		overflow ||= counts.overflow;
		const functionIdentityCounts = new Map<string, number>();
		for (const fn of manifest.prepared.functions) {
			if (fn.identity.status !== "known") continue;
			const key = `${fn.identity.origin}:${fn.identity.revision}`;
			functionIdentityCounts.set(key, (functionIdentityCounts.get(key) ?? 0) + 1);
		}
		manifest.prepared.functions.forEach((fn, index) => {
			const identity = fn.identity;
			if ("reason" in identity) {
				coverage.unknownFunctions++;
				return;
			}
			const count = counts.functions[index]!;
			if (count === 0n) coverage.observedZeroFunctions++;
			const key = `${identity.origin}:${identity.revision}`;
			const prior = functions.get(key);
			functions.set(key, {
				origin: identity.origin,
				revision: identity.revision,
				count: add(prior?.count ?? 0n, count),
			});
		});
		manifest.prepared.calls.forEach((site, index) => {
			if (!site.instrumented) {
				coverage.uninstrumentedCalls++;
				return;
			}
			if (site.identity.status !== "known") {
				coverage.unknownCalls++;
				return;
			}
			const count = counts.calls[index]!;
			if (count === 0n) coverage.observedZeroCalls++;
			calls.set(site.identity.key, add(calls.get(site.identity.key) ?? 0n, count));
			const observation = counts.targets[index]!;
			if (!site.targetInstrumented || observation.truncated) {
				targetUnknownCalls.add(site.identity.key);
				coverage.incompleteTargetCalls++;
				return;
			}
			for (const entry of observation.entries) {
				const identity = manifest.prepared.functions[entry.functionIndex]!.identity;
				if (
					identity.status !== "known" ||
					functionIdentityCounts.get(`${identity.origin}:${identity.revision}`) !== 1
				) {
					targetUnknownCalls.add(site.identity.key);
					coverage.incompleteTargetCalls++;
					return;
				}
			}
			for (const entry of observation.entries) {
				const identity = manifest.prepared.functions[entry.functionIndex]!.identity;
				if (identity.status !== "known") throw new Error("Unresolved PGO target");
				const targetKey = `${site.identity.key}:${identity.origin}:${identity.revision}`;
				const prior = targets.get(targetKey);
				targets.set(targetKey, {
					key: site.identity.key,
					origin: identity.origin,
					revision: identity.revision,
					count: add(prior?.count ?? 0n, entry.count),
				});
			}
		});
	}
	if (functions.size + calls.size + targets.size > MAX_COUNTERS)
		throw new Error("PGO merged profile counter limit exceeded");
	const profile: MergedPgoProfile = {
		schema: 3,
		semantics: 2,
		semanticKey,
		digest: "",
		overflow,
		runs: ordered.map(({ manifest, counts }) => ({
			runId: manifest.runId,
			workload: manifest.workload,
			producer: manifest.prepared.producer,
			image: manifest.prepared.image,
			captureIdentity: manifest.captureIdentity,
			payloadDigest: counts.payloadDigest,
		})),
		cpuCaptures: orderedCpu.map((evidence) => ({
			captureId: evidence.captureId,
			workload: evidence.workload,
			producer: evidence.producer,
			image: evidence.buildId,
			captureIdentity: evidence.captureIdentity,
			payloadDigest: evidence.payloadDigest,
			intervalUs: evidence.intervalUs,
			totalSamples: evidence.totalSamples,
			unattributedSamples: evidence.unattributedSamples,
			ambiguousSamples: evidence.ambiguousSamples,
			functions: evidence.functions.map((row) => ({
				origin: row.origin,
				revision: row.revision,
				samples: String(row.samples),
			})),
		})),
		cpuFunctions: [...cpuFunctions.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, row]) => ({
				origin: row.origin,
				revision: row.revision,
				samples: String(row.samples),
				estimatedCpuNs: String(row.estimatedCpuNs),
			})),
		functions: [...functions.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, fn]) => ({ ...fn, count: String(fn.count) })),
		calls: [...calls.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, count]) => ({ key, count: String(count) })),
		targets: [...targets.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, target]) => ({ ...target, count: String(target.count) })),
		targetUnknownCalls: [...targetUnknownCalls].sort(),
		coverage,
	};
	profile.digest = mergedIdentity(profile);
	const file = path.resolve(
		output ?? path.join(".cache/pgo/merged", `${profile.digest}.json`),
	);
	publishPgoProfile(file, profile);
	return { profile, path: file };
}

function mergedIdentity(profile: MergedPgoProfile): string {
	const { digest: _digest, ...contents } = profile;
	return digest(contents);
}

export function readPgoProfile(file: string, semanticKey: string): MergedPgoProfile {
	const profile = JSON.parse(readFileSync(file, "utf8")) as MergedPgoProfile;
	if (
		profile.schema !== 3 ||
		profile.semantics !== 2 ||
		profile.semanticKey !== semanticKey
	)
		throw new Error("PGO semantic configuration or schema mismatch");
	if (profile.digest !== mergedIdentity(profile))
		throw new Error("PGO profile checksum mismatch");
	if (
		!Array.isArray(profile.functions) ||
		!Array.isArray(profile.cpuCaptures) ||
		!Array.isArray(profile.cpuFunctions) ||
		!Array.isArray(profile.calls) ||
		!Array.isArray(profile.targets) ||
		!Array.isArray(profile.targetUnknownCalls) ||
		profile.functions.length +
			profile.calls.length +
			profile.targets.length +
			profile.cpuFunctions.length +
			profile.cpuCaptures.length >
			MAX_COUNTERS
	)
		throw new Error("PGO profile counter limit exceeded");
	if (
		profile.functions.some(
			(row) =>
				typeof row.origin !== "string" ||
				typeof row.revision !== "string" ||
				"key" in row,
		) ||
		profile.calls.some(
			(row) => typeof row.key !== "string" || "origin" in row || "revision" in row,
		) ||
		profile.targets.some(
			(row) =>
				typeof row.key !== "string" ||
				typeof row.origin !== "string" ||
				typeof row.revision !== "string",
		)
	)
		throw new Error("Invalid PGO profile row shape");
	const keys = new Set<string>();
	for (const row of [...profile.functions, ...profile.calls]) {
		const key = "key" in row ? row.key : `${row.origin}:${row.revision}`;
		if (!/^[0-9a-f]{64}(?::[0-9a-f]{64})?$/u.test(key) || keys.has(key))
			throw new Error("PGO profile keys are invalid or duplicated");
		keys.add(key);
		if (
			typeof row.count !== "string" ||
			!/^(0|[1-9][0-9]{0,19})$/u.test(row.count) ||
			BigInt(row.count) > MAX_COUNT
		)
			throw new Error("PGO profile count is outside u64");
	}
	const targetKeys = new Set<string>();
	const sourceAttempts = new Map(
		profile.calls.map((row) => [row.key, BigInt(row.count)]),
	);
	const knownFunctions = new Set(
		profile.functions.map((row) => `${row.origin}:${row.revision}`),
	);
	const targetTotals = new Map<string, bigint>();
	for (const row of profile.targets) {
		const key = `${row.key}:${row.origin}:${row.revision}`;
		if (
			!/^[0-9a-f]{64}(:[0-9a-f]{64}){2}$/u.test(key) ||
			targetKeys.has(key) ||
			!sourceAttempts.has(row.key) ||
			!knownFunctions.has(`${row.origin}:${row.revision}`)
		)
			throw new Error("PGO target profile keys are invalid or duplicated");
		targetKeys.add(key);
		if (
			typeof row.count !== "string" ||
			!/^(0|[1-9][0-9]{0,19})$/u.test(row.count) ||
			BigInt(row.count) > MAX_COUNT
		)
			throw new Error("PGO target profile count is outside u64");
		targetTotals.set(row.key, (targetTotals.get(row.key) ?? 0n) + BigInt(row.count));
	}
	if (!profile.overflow)
		for (const [key, count] of targetTotals)
			if (count > sourceAttempts.get(key)!)
				throw new Error("PGO target matches exceed source attempts");
	const unknownKeys = new Set<string>();
	for (const key of profile.targetUnknownCalls) {
		if (
			typeof key !== "string" ||
			!/^[0-9a-f]{64}$/u.test(key) ||
			unknownKeys.has(key) ||
			!sourceAttempts.has(key)
		)
			throw new Error("PGO incomplete target keys are invalid or duplicated");
		unknownKeys.add(key);
	}
	const captureIds = new Set<string>();
	const capturedCpuFunctions = new Map<
		string,
		{ samples: bigint; estimatedCpuNs: bigint }
	>();
	for (const capture of profile.cpuCaptures) {
		if (
			!isDigest(capture.captureId) ||
			!isDigest(capture.image) ||
			!isDigest(capture.captureIdentity) ||
			!isDigest(capture.payloadDigest) ||
			captureIds.has(capture.captureId) ||
			typeof capture.workload !== "string" ||
			capture.workload.trim() === "" ||
			typeof capture.producer !== "string" ||
			capture.producer.trim() === "" ||
			!Number.isSafeInteger(capture.intervalUs) ||
			capture.intervalUs <= 0 ||
			!Number.isSafeInteger(capture.totalSamples) ||
			capture.totalSamples < 20 ||
			!Number.isSafeInteger(capture.unattributedSamples) ||
			!Number.isSafeInteger(capture.ambiguousSamples) ||
			capture.unattributedSamples < 0 ||
			capture.ambiguousSamples < 0 ||
			capture.unattributedSamples + capture.ambiguousSamples > capture.totalSamples ||
			!Array.isArray(capture.functions) ||
			capture.functions.length > MAX_COUNTERS
		)
			throw new Error("PGO CPU capture provenance is invalid or duplicated");
		captureIds.add(capture.captureId);
		const seen = new Set<string>();
		let attributed = 0n;
		for (const row of capture.functions) {
			const key = `${row.origin}:${row.revision}`;
			if (
				!isDigest(row.origin) ||
				!isDigest(row.revision) ||
				!isU64Decimal(row.samples) ||
				BigInt(row.samples) === 0n ||
				seen.has(key)
			)
				throw new Error("PGO CPU capture function attribution is invalid");
			seen.add(key);
			const samples = BigInt(row.samples);
			attributed += samples;
			const prior = capturedCpuFunctions.get(key);
			capturedCpuFunctions.set(key, {
				samples: (prior?.samples ?? 0n) + samples,
				estimatedCpuNs:
					(prior?.estimatedCpuNs ?? 0n) + samples * BigInt(capture.intervalUs) * 1_000n,
			});
		}
		if (
			attributed !==
			BigInt(
				capture.totalSamples - capture.unattributedSamples - capture.ambiguousSamples,
			)
		)
			throw new Error("PGO CPU capture attribution does not match sample totals");
	}
	const cpuKeys = new Set<string>();
	for (const row of profile.cpuFunctions) {
		const key = `${row.origin}:${row.revision}`;
		if (
			!isDigest(row.origin) ||
			!isDigest(row.revision) ||
			cpuKeys.has(key) ||
			!isU64Decimal(row.samples) ||
			!isU64Decimal(row.estimatedCpuNs) ||
			BigInt(row.samples) === 0n ||
			capturedCpuFunctions.get(key)?.samples !== BigInt(row.samples) ||
			capturedCpuFunctions.get(key)?.estimatedCpuNs !== BigInt(row.estimatedCpuNs)
		)
			throw new Error("PGO CPU function row is invalid or duplicated");
		cpuKeys.add(key);
	}
	if (cpuKeys.size !== capturedCpuFunctions.size)
		throw new Error("PGO CPU function rows do not match capture provenance");
	return profile;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isU64Decimal(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^(0|[1-9][0-9]{0,19})$/u.test(value) &&
		BigInt(value) <= MAX_COUNT
	);
}

function publishPgoProfile(file: string, profile: MergedPgoProfile): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${randomUUID()}`;
	try {
		writeFileSync(temporary, `${JSON.stringify(profile)}\n`, { flag: "wx" });
		try {
			linkSync(temporary, file);
		} catch (error) {
			if (!existsSync(file)) throw error;
			const existing = readPgoProfile(file, profile.semanticKey);
			if (existing.digest !== profile.digest)
				throw new Error("PGO profiles are immutable; choose a new output path");
		}
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function pgoOptimizationInput(
	profile: MergedPgoProfile,
	options: { collectQueryCoverage?: boolean; measuredWorkBonusPercent?: number } = {},
): CorePgoInput {
	const functions = new Map(
		profile.functions.map((row) => [
			`${row.origin}:${row.revision}`,
			Math.min(Number(row.count), Number.MAX_SAFE_INTEGER),
		]),
	);
	const cpuFunctions = new Map(
		profile.cpuFunctions
			.filter((row) => BigInt(row.samples) >= 20n)
			.map((row) => [
				`${row.origin}:${row.revision}`,
				Math.min(Number(row.estimatedCpuNs), Number.MAX_SAFE_INTEGER),
			]),
	);
	const calls = new Map(
		profile.calls.map((row) => [
			row.key,
			Math.min(Number(row.count), Number.MAX_SAFE_INTEGER),
		]),
	);
	const targets = new Map(
		profile.targets.map((row) => [
			`${row.key}:${row.origin}:${row.revision}`,
			Math.min(Number(row.count), Number.MAX_SAFE_INTEGER),
		]),
	);
	const targetUnknownCalls = new Set(profile.targetUnknownCalls);
	const targetRevisions = new Map<string, Set<string>>();
	for (const row of profile.functions) {
		let revisions = targetRevisions.get(row.origin);
		if (revisions === undefined) {
			revisions = new Set();
			targetRevisions.set(row.origin, revisions);
		}
		revisions.add(row.revision);
	}
	const profileOrigins = options.collectQueryCoverage
		? new Set(profile.functions.map((row) => row.origin))
		: undefined;
	return {
		digest: profile.digest,
		policy: `cpu-local-v1-work-${options.measuredWorkBonusPercent ?? 0}-target-zero-v2-unknown-20:${compilerProducerIdentity("pgo-training", 2)}`,
		bind({ program, context }) {
			const identities = new SourceProfileIdentities();
			const origins = new Map(
				[...program.functionIds()].map((id) => [
					id,
					program.function(id).metadata.sourceOrigin,
				]),
			);
			const functionCounts = new Map<number, number | undefined>();
			const functionCpuCosts = new Map<number, number | undefined>();
			const callCounts = new Map<number, number | undefined>();
			let currentSourceCalls: Map<number, number> | undefined;
			let currentSourceFunctionsVersion = -1;
			let currentSourceCallsVersion = -1;
			let currentTargetIdentities: Map<string, number> | undefined;
			let currentTargetIdentityVersion = -1;
			const diagnostics = options.collectQueryCoverage
				? {
						functions: new Map<number, keyof CorePgoQueryCoverage["functions"]>(),
						calls: new Map<string, keyof CorePgoQueryCoverage["calls"]>(),
						callCounts: new Map<number, keyof CorePgoQueryCoverage["calls"]>(),
						targets: new Map<string, keyof CorePgoQueryCoverage["targets"]>(),
					}
				: undefined;
			return {
				digest: profile.digest,
				measuredWorkBonusPercent: options.measuredWorkBonusPercent,
				...(cpuFunctions.size === 0
					? {}
					: {
							functionCpuCost(id: CoreFunctionId) {
								if (functionCpuCosts.has(id)) return functionCpuCosts.get(id);
								const fn = program.function(id);
								const identity = identities.functionIdentity(origins.get(id));
								const cost =
									fn.isGenerator || identity.status !== "known"
										? undefined
										: cpuFunctions.get(`${identity.origin}:${identity.revision}`);
								functionCpuCosts.set(id, cost);
								return cost;
							},
						}),
				functionEntries(id) {
					if (functionCounts.has(id)) return functionCounts.get(id);
					const fn = program.function(id);
					const identity = identities.functionIdentity(origins.get(id));
					const count =
						fn.isGenerator || "reason" in identity
							? undefined
							: functions.get(`${identity.origin}:${identity.revision}`);
					if (diagnostics !== undefined) {
						let outcome: keyof CorePgoQueryCoverage["functions"];
						if (fn.isGenerator) outcome = "unsupportedBody";
						else if ("reason" in identity) outcome = "missingOrigin";
						else if (count === undefined)
							outcome =
								profileOrigins?.has(identity.origin) === true
									? "unmatchedRevision"
									: "untrainedOrigin";
						else outcome = count === 0 ? "zero" : "positive";
						diagnostics.functions.set(id, outcome);
					}
					functionCounts.set(id, count);
					return count;
				},
				callAttempts(id, instruction) {
					const siteId = program
						.function(id)
						.instructionAttributes(instruction).sourceCall;
					if (typeof siteId !== "number") {
						diagnostics?.calls.set(`${id}:${instruction}`, "missingSite");
						return undefined;
					}
					const site = context.data.sourceCallSites?.[siteId];
					if (site === undefined || site.owner === undefined) {
						diagnostics?.calls.set(`${id}:${instruction}`, "missingOrigin");
						return undefined;
					}
					if (site.owner !== origins.get(id)) {
						diagnostics?.calls.set(`${id}:${instruction}`, "ownerMismatch");
						return undefined;
					}
					if (callCounts.has(siteId)) {
						const count = callCounts.get(siteId);
						if (diagnostics !== undefined)
							diagnostics.calls.set(
								`${id}:${instruction}`,
								diagnostics.callCounts.get(siteId)!,
							);
						return count;
					}
					const identity = identities.callIdentity(site);
					const count = identity.status === "known" ? calls.get(identity.key) : undefined;
					if (diagnostics !== undefined) {
						let outcome: keyof CorePgoQueryCoverage["calls"];
						if (identity.status !== "known") outcome = "missingOrigin";
						else if (count === undefined) outcome = "unmatchedProfile";
						else outcome = count === 0 ? "zero" : "positive";
						diagnostics.calls.set(`${id}:${instruction}`, outcome);
						diagnostics.callCounts.set(siteId, outcome);
					}
					callCounts.set(siteId, count);
					return count;
				},
				guardedCallHits(id, instruction, targetFunctions) {
					const finish = (result: number | undefined) => {
						diagnostics?.targets.set(
							`${id}:${instruction}:${targetFunctions.join(",")}`,
							result === undefined ? "unknown" : result === 0 ? "zero" : "positive",
						);
						return result;
					};
					if (profile.overflow || targetFunctions.length === 0) return finish(undefined);
					const function_ = program.function(id);
					if (
						function_.registry.byId(function_.instructionOpcode(instruction)).callTransfer
							?.invocation !== "call"
					)
						return finish(undefined);
					const attributes = function_.instructionAttributes(instruction);
					const siteId = attributes.sourceCall;
					if (typeof siteId !== "number") return finish(undefined);
					const site = context.data.sourceCallSites?.[siteId];
					if (site?.owner === undefined || site.owner !== origins.get(id))
						return finish(undefined);
					const sourceIdentity = identities.callIdentity(site);
					if (
						sourceIdentity.status !== "known" ||
						!calls.has(sourceIdentity.key) ||
						targetUnknownCalls.has(sourceIdentity.key)
					)
						return finish(undefined);
					const functionsVersion = program.programVersion("functions");
					const callsVersion = program.functionVersion("calls");
					if (
						currentSourceCalls === undefined ||
						currentSourceFunctionsVersion !== functionsVersion ||
						currentSourceCallsVersion !== callsVersion
					) {
						currentSourceCalls = new Map();
						currentSourceFunctionsVersion = functionsVersion;
						currentSourceCallsVersion = callsVersion;
						for (const functionId of program.functionIds()) {
							const body = program.function(functionId);
							for (const current of body.instructionIds()) {
								if (
									body.instructionKind(current) !== "operation" ||
									body.registry.byId(body.instructionOpcode(current)).callTransfer ===
										undefined
								)
									continue;
								const sourceCall = body.instructionAttributes(current).sourceCall;
								if (typeof sourceCall === "number")
									currentSourceCalls.set(
										sourceCall,
										(currentSourceCalls.get(sourceCall) ?? 0) + 1,
									);
							}
						}
					}
					if (currentSourceCalls.get(siteId) !== 1) return finish(undefined);
					const functionVersion = program.programVersion("functions");
					if (
						currentTargetIdentities === undefined ||
						currentTargetIdentityVersion !== functionVersion
					) {
						currentTargetIdentities = new Map();
						currentTargetIdentityVersion = functionVersion;
						for (const functionId of program.functionIds()) {
							const identity = identities.functionIdentity(
								program.function(functionId).metadata.sourceOrigin,
							);
							if (identity.status !== "known") continue;
							const key = `${identity.origin}:${identity.revision}`;
							currentTargetIdentities.set(
								key,
								(currentTargetIdentities.get(key) ?? 0) + 1,
							);
						}
					}
					const distinct = new Set<string>();
					let total = 0;
					for (const target of targetFunctions) {
						const identity = identities.functionIdentity(
							program.function(target).metadata.sourceOrigin,
						);
						if (identity.status !== "known") return finish(undefined);
						const key = `${identity.origin}:${identity.revision}`;
						if (
							currentTargetIdentities.get(key) !== 1 ||
							targetRevisions.get(identity.origin)?.size !== 1 ||
							!targetRevisions.get(identity.origin)?.has(identity.revision)
						)
							return finish(undefined);
						if (distinct.has(key)) continue;
						distinct.add(key);
						total +=
							targets.get(
								`${sourceIdentity.key}:${identity.origin}:${identity.revision}`,
							) ?? 0;
					}
					return finish(Math.min(total, Number.MAX_SAFE_INTEGER));
				},
				...(diagnostics === undefined
					? {}
					: {
							queryCoverage(): CorePgoQueryCoverage {
								const functions = {
									positive: 0,
									zero: 0,
									unmatchedRevision: 0,
									untrainedOrigin: 0,
									missingOrigin: 0,
									unsupportedBody: 0,
								};
								const calls = {
									positive: 0,
									zero: 0,
									unmatchedProfile: 0,
									missingSite: 0,
									missingOrigin: 0,
									ownerMismatch: 0,
								};
								const targets = { positive: 0, zero: 0, unknown: 0 };
								for (const outcome of diagnostics.functions.values())
									functions[outcome]++;
								for (const outcome of diagnostics.calls.values()) calls[outcome]++;
								for (const outcome of diagnostics.targets.values()) targets[outcome]++;
								return { functions, calls, targets };
							},
						}),
			};
		},
	};
}
