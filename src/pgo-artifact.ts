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
import type { CorePgoInput, CorePgoQueryCoverage } from "./compiler/core/core-pgo.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";
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

export interface PreparedPgo {
	schema: 1;
	semantics: 1;
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
		identity: ProfileCallIdentity;
	}>;
}

export interface PgoCaptureManifest {
	schema: 1;
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
	schema: 1;
	semantics: 1;
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
	functions: Array<{ origin: string; revision: string; count: string }>;
	calls: Array<{ key: string; count: string }>;
	coverage: {
		unknownFunctions: number;
		unknownCalls: number;
		uninstrumentedCalls: number;
		observedZeroFunctions: number;
		observedZeroCalls: number;
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
	if (image.runtime.functions.length + sites.length > MAX_COUNTERS)
		throw new Error("PGO counter limit exceeded");
	const instrumented = new Set<number>();
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
		}
	const resolver = new SourceProfileIdentities();
	const prepared: PreparedPgo = {
		schema: 1,
		semantics: 1,
		producer: compilerProducerIdentity("pgo-training", 1),
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
		schema: 1,
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
		Buffer.from(bytes.subarray(0, 8)).toString() !== "MALPGO1\0" ||
		view.getUint32(8, true) !== 1 ||
		view.getUint32(12, true) !== 1
	)
		throw new Error("PGO payload schema or semantics mismatch");
	const functionCount = view.getUint32(16, true);
	const callCount = view.getUint32(20, true);
	const flags = view.getUint32(24, true);
	if (flags > 3 || view.getUint32(28, true) !== 0)
		throw new Error("PGO payload flags are invalid");
	if (
		functionCount + callCount > MAX_COUNTERS ||
		bytes.length !== 64 + (functionCount + callCount) * 8
	)
		throw new Error("PGO payload counter length mismatch");
	const counts = Array.from({ length: functionCount + callCount }, (_, index) =>
		view.getBigUint64(64 + index * 8, true),
	);
	return {
		captureIdentity: Buffer.from(bytes.subarray(32, 64)).toString("hex"),
		overflow: (flags & 1) !== 0,
		invalid: (flags & 2) !== 0,
		functions: counts.slice(0, functionCount),
		calls: counts.slice(functionCount),
	};
}

function validatePrepared(prepared: PreparedPgo): void {
	const hex = (value: unknown) =>
		typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
	if (
		prepared.schema !== 1 ||
		prepared.semantics !== 1 ||
		!hex(prepared.semanticKey) ||
		!hex(prepared.image) ||
		typeof prepared.producer !== "string" ||
		!Array.isArray(prepared.functions) ||
		!Array.isArray(prepared.calls) ||
		prepared.functions.length + prepared.calls.length > MAX_COUNTERS
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
		manifest.schema !== 1 ||
		manifest.prepared.schema !== 1 ||
		manifest.prepared.semantics !== 1
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
	const functions = new Map<
		string,
		{ origin: string; revision: string; count: bigint }
	>();
	const calls = new Map<string, bigint>();
	const coverage = {
		unknownFunctions: 0,
		unknownCalls: 0,
		uninstrumentedCalls: 0,
		observedZeroFunctions: 0,
		observedZeroCalls: 0,
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
		});
	}
	const profile: MergedPgoProfile = {
		schema: 1,
		semantics: 1,
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
		functions: [...functions.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, fn]) => ({ ...fn, count: String(fn.count) })),
		calls: [...calls.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, count]) => ({ key, count: String(count) })),
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
		profile.schema !== 1 ||
		profile.semantics !== 1 ||
		profile.semanticKey !== semanticKey
	)
		throw new Error("PGO semantic configuration or schema mismatch");
	if (profile.digest !== mergedIdentity(profile))
		throw new Error("PGO profile checksum mismatch");
	if (
		!Array.isArray(profile.functions) ||
		!Array.isArray(profile.calls) ||
		profile.functions.length + profile.calls.length > MAX_COUNTERS
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
	return profile;
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
	options: { collectQueryCoverage?: boolean } = {},
): CorePgoInput {
	const functions = new Map(
		profile.functions.map((row) => [
			`${row.origin}:${row.revision}`,
			Math.min(Number(row.count), Number.MAX_SAFE_INTEGER),
		]),
	);
	const calls = new Map(
		profile.calls.map((row) => [
			row.key,
			Math.min(Number(row.count), Number.MAX_SAFE_INTEGER),
		]),
	);
	const profileOrigins = options.collectQueryCoverage
		? new Set(profile.functions.map((row) => row.origin))
		: undefined;
	return {
		digest: profile.digest,
		policy: `exposure-v1-unknown-20:${compilerProducerIdentity("pgo-training", 1)}`,
		bind({ program, context }) {
			const identities = new SourceProfileIdentities();
			const origins = new Map(
				[...program.functionIds()].map((id) => [
					id,
					program.function(id).metadata.sourceOrigin,
				]),
			);
			const functionCounts = new Map<number, number | undefined>();
			const callCounts = new Map<number, number | undefined>();
			const diagnostics = options.collectQueryCoverage
				? {
						functions: new Map<number, keyof CorePgoQueryCoverage["functions"]>(),
						calls: new Map<string, keyof CorePgoQueryCoverage["calls"]>(),
						callCounts: new Map<number, keyof CorePgoQueryCoverage["calls"]>(),
					}
				: undefined;
			return {
				digest: profile.digest,
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
								for (const outcome of diagnostics.functions.values())
									functions[outcome]++;
								for (const outcome of diagnostics.calls.values()) calls[outcome]++;
								return { functions, calls };
							},
						}),
			};
		},
	};
}
