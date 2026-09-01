import { hash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { CoreOptimizationPlan } from "./compiler/core/core-ir-regions.ts";
import type { CoreOptimizationReport } from "./compiler/core/core-optimization-report.ts";
import type { CompilerFactFlowReport } from "./compiler/shared/compiler-diagnostics.ts";
import type { CompilerRemark, ProfileSite } from "./compiler/target/profile-metadata.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";
import { profilePhaseName } from "./profile-phases.ts";

const CAPTURE_LEGACY_HEADER_BYTES = 40;
const CAPTURE_V3_HEADER_BYTES = 48;
const CAPTURE_V4_HEADER_BYTES = 80;
const CAPTURE_RECORD_BYTES = 40;
const CAPTURE_FRAME_V1_BYTES = 8;
const CAPTURE_FRAME_V2_BYTES = 12;
const COMPILER_V1_HEADER_BYTES = 24;
const COMPILER_V2_HEADER_BYTES = 32;
const COMPILER_V3_HEADER_BYTES = 64;
const COMPILER_V1_EVENT_NAMES = [
	"executions",
	"fastPaths",
	"fallbacks",
	"allocationCount",
	"allocationRequestedBytes",
	"boxing",
	"safepoints",
	"gc",
] as const;
const COMPILER_V2_EVENT_NAMES = [
	"executions",
	"fallbacks",
	"allocationCount",
	"allocationRequestedBytes",
	"allocationChargedBytes",
	"boxing",
	"safepoints",
	"gc",
] as const;
const COMPILER_V4_EVENT_NAMES = [
	...COMPILER_V2_EVENT_NAMES,
	"runtimeDispatch",
	"runtimeString",
	"runtimeRegExp",
	"runtimeHost",
] as const;

type CompilerEventName =
	| (typeof COMPILER_V1_EVENT_NAMES)[number]
	| (typeof COMPILER_V2_EVENT_NAMES)[number]
	| (typeof COMPILER_V4_EVENT_NAMES)[number];
type CompilerEvents = Record<CompilerEventName, number>;

const ALLOCATION_STORAGE_NAMES = [
	"none",
	"managed-cell",
	"raw-payload",
	"native-backing",
];
const ALLOCATION_FAMILY_NAMES = [
	"unknown",
	"object",
	"string",
	"array",
	"function",
	"collection",
	"buffer",
	"regexp",
	"promise",
	"iterator",
	"host",
	"metadata",
];

export interface PreparedProfile {
	schema: 1 | 2 | 3;
	mode: "sampling" | "compiler";
	buildId: string;
	captureIdentity?: string;
	entrypoint: string;
	functions: Array<{ name: string; file: string }>;
	sites: Array<ProfileSite>;
	remarks: Array<CompilerRemark>;
	coreOptimizationReport?: CoreOptimizationReport;
	coreOptimizationPlan?: CoreOptimizationPlan;
	factFlow?: CompilerFactFlowReport;
}

export interface ProfileOptimizationSidecar {
	readonly coreOptimizationReport?: CoreOptimizationReport;
	readonly coreOptimizationPlan?: CoreOptimizationPlan;
}

interface RawFrame {
	functionIndex: number;
	positionId: number;
	siteId: number;
}

interface RawRecord {
	kind: number;
	timestampNs: number;
	value: number;
	auxiliary: number;
	omittedFrames: number;
	depthTruncated: boolean;
	capacityTruncated: boolean;
	allocationStorage: number;
	allocationFamily: number;
	allocationObjectType: number;
	frames: Array<RawFrame>;
}

interface RawCapture {
	schema: 1 | 2 | 3 | 4;
	captureIdentity?: string;
	intervalUs: number;
	allocationIntervalBytes: number;
	allocationSampling: "legacy-fixed" | "poisson";
	samplingClock: "legacy-mixed" | "process-cpu";
	droppedRecords: number;
	droppedFrames: number;
	records: Array<RawRecord>;
}

export interface CompilerAllocationCounter {
	siteId: number;
	storage: number;
	family: number;
	objectType: number;
	count: number;
	requestedBytes: number;
	chargedBytes: number;
}

interface CompilerCapture {
	schema: 1 | 2 | 3 | 4;
	captureIdentity?: string;
	trackedSiteCount: number;
	totalSiteCount: number;
	unattributed: CompilerEvents;
	bySite: Array<CompilerEvents>;
	allocations: Array<CompilerAllocationCounter>;
}

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new Error("profile metadata is not serializable");
		return encoded;
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object") throw new Error("profile metadata is not serializable");
	return `{${Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(",")}}`;
}

/** Content identity binding the linked binary hash to its complete profile sidecar. */
export function profileCaptureIdentity(prepared: PreparedProfile): string {
	const payload = Object.fromEntries(
		Object.entries(prepared).filter(([key]) => key !== "captureIdentity"),
	);
	return hash("sha256", canonicalJson(payload), "hex");
}

function validatedCaptureIdentity(prepared: PreparedProfile): string {
	const identity = prepared.captureIdentity;
	if (
		prepared.schema !== 3 ||
		identity === undefined ||
		!/^[0-9a-f]{64}$/u.test(identity)
	) {
		throw new Error("profile metadata does not contain a valid capture identity");
	}
	if (profileCaptureIdentity(prepared) !== identity) {
		throw new Error("profile metadata capture identity does not match its contents");
	}
	return identity;
}

export interface ProfileFinding {
	siteId: number;
	logicalId: string;
	originId: string;
	instanceId: string;
	regionId: string;
	operation: string;
	functionIndex: number;
	instructionIndex: number;
	file: string;
	line: number;
	column: number;
	cpuSamples: number;
	cpuShare: number;
	allocationSamples: number;
	sampledBytes: number;
	sampledChargedBytes: number;
	estimatedRequestedBytes: number;
	estimatedChargedBytes: number;
	allocationEstimated: boolean;
	allocationFamilies: Array<{
		storage: string;
		family: string;
		samples: number;
		requestedBytes: number;
		chargedBytes: number;
		estimatedChargedBytes: number;
	}>;
	remarks: Array<CompilerRemark["code"]>;
	decisions: Array<CompilerRemark>;
	compiler?: CompilerEvents;
	compilerAllocations?: Array<CompilerAllocationCounter>;
	cpuConfidence: "none" | "low" | "medium" | "high";
	allocationConfidence: "none" | "low" | "medium" | "high";
}

const REMARK_EXPLANATIONS: Record<string, string> = {
	"allocation.finite-shape": "compiler emitted guarded finite-shape allocation",
	"allocation.heap": "allocation retains observable heap identity",
	"allocation.stack": "allocation was elided into the native stack frame",
	"allocation.virtualized": "allocation is virtualized behind a materialization guard",
	"boxing.value-materialization": "native value is materialized in boxed representation",
	"call.builtin-direct": "call uses a semantics-preserving runtime direct helper",
	"call.direct-compiled": "call targets compiled code directly",
	"call.direct-native": "call uses the native-number compiled ABI",
	"call.inline-cache": "dynamic call retains its runtime target cache",
	"call.projected": "call result is projected behind a semantic fallback",
	"call.generic": "call stayed on generic dispatch",
	"call.guarded": "compiler emitted guarded direct dispatch",
	"boxing.generic": "operation retains generic boxed semantics",
	"object.heap": "object remains heap allocated",
	"object.shaped": "compiler selected shaped-object construction",
	"property.dynamic-load": "dynamic key kept the property load generic",
	"property.dynamic-store": "dynamic key kept the property store generic",
	"property.static-load": "compiler selected a static-key load cache",
	"property.static-store": "compiler selected a static-key store cache",
	"property.dynamic-inline-cache": "dynamic key retains its runtime shape cache",
	"property.array-inline-cache": "array access uses a guarded indexed cache",
	"property.finite-key": "property access uses a guarded finite-key projection",
	"property.projected": "property access is projected behind a semantic fallback",
	"property.static-inline-cache": "static key retains its runtime shape cache",
	"property.watched": "property access is specialized behind an invalidatable epoch",
};

function functionName(image: ProgramImage, index: number): string {
	const fn = image.runtime.functions[index];
	if (fn === undefined) return "<unknown>";
	return (
		String.fromCodePoint(...(image.runtime.stringConstants[fn.nameStringIndex] ?? [])) ||
		"<anonymous>"
	);
}

/** Freeze the compiler-side half of a capture next to the exact linked binary. */
export function prepareProfile(
	binaryPath: string,
	image: ProgramImage,
	mode: PreparedProfile["mode"] = "sampling",
	optimization: ProfileOptimizationSidecar = {},
): PreparedProfile {
	const prepared: PreparedProfile = {
		schema: 3,
		mode,
		buildId: hash("sha256", readFileSync(binaryPath), "hex"),
		entrypoint: image.runtime.entrypointPath,
		functions: image.runtime.functions.map((fn, index) => ({
			name: functionName(image, index),
			file: image.runtime.files[fn.fileIndex] ?? "<unknown>",
		})),
		sites: image.diagnostics.profileSites ?? [],
		remarks: image.diagnostics.profileRemarks ?? [],
		coreOptimizationReport: optimization.coreOptimizationReport,
		coreOptimizationPlan: optimization.coreOptimizationPlan,
		factFlow: image.diagnostics.factFlow,
	};
	prepared.captureIdentity = profileCaptureIdentity(prepared);
	atomicJson(`${binaryPath}.profile.json`, prepared, true);
	return prepared;
}

export function defaultProfileDirectory(
	command: string,
	prepared: PreparedProfile,
	cwd = process.cwd(),
): string {
	const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	return path.join(
		cwd,
		".maligator",
		"profiles",
		`${timestamp}-${command}-${prepared.buildId.slice(0, 12)}`,
	);
}

export function createProfileCapture(
	command: string,
	prepared: PreparedProfile,
	cwd = process.cwd(),
): {
	directory: string;
	capturePath: string;
	environment: { MAL_PROFILE_CAPTURE: string; MAL_PROFILE_IDENTITY: string };
} {
	const captureIdentity = validatedCaptureIdentity(prepared);
	const override = process.env.MALIGATOR_PROFILE_DIRECTORY;
	const directory = path.resolve(
		override === undefined
			? defaultProfileDirectory(command, prepared, cwd)
			: command.startsWith("dev-")
				? path.join(override, command)
				: override,
	);
	mkdirSync(directory, { recursive: true });
	atomicJson(path.join(directory, "metadata.json"), prepared, true);
	const capturePath = path.join(directory, "capture.bin");
	return {
		directory,
		capturePath,
		environment: {
			MAL_PROFILE_CAPTURE: capturePath,
			MAL_PROFILE_IDENTITY: captureIdentity,
		},
	};
}

function checkedNumber(value: bigint, label: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number))
		throw new Error(`${label} exceeds JavaScript safe range`);
	return number;
}

export function parseProfileCapture(bytes: Uint8Array): RawCapture {
	if (bytes.byteLength < CAPTURE_LEGACY_HEADER_BYTES)
		throw new Error("profile capture is truncated");
	const magic = Buffer.from(bytes.subarray(0, 8)).toString();
	if (
		magic !== "MALPROF1" &&
		magic !== "MALPROF2" &&
		magic !== "MALPROF3" &&
		magic !== "MALPROF4"
	) {
		throw new Error("profile capture has an unknown magic value");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const schema = view.getUint32(8, true);
	if (
		(magic === "MALPROF1" && schema !== 1) ||
		(magic === "MALPROF2" && schema !== 2) ||
		(magic === "MALPROF3" && schema !== 3) ||
		(magic === "MALPROF4" && schema !== 4)
	)
		throw new Error("profile capture schema is unsupported");
	const typedSchema = schema as 1 | 2 | 3 | 4;
	const headerBytes =
		schema === 4
			? CAPTURE_V4_HEADER_BYTES
			: schema === 3
				? CAPTURE_V3_HEADER_BYTES
				: CAPTURE_LEGACY_HEADER_BYTES;
	if (bytes.byteLength < headerBytes) throw new Error("profile capture is truncated");
	const recordCount = view.getUint32(12, true);
	const frameCount = view.getUint32(16, true);
	const frameBytes = schema === 1 ? CAPTURE_FRAME_V1_BYTES : CAPTURE_FRAME_V2_BYTES;
	const expected =
		headerBytes + recordCount * CAPTURE_RECORD_BYTES + frameCount * frameBytes;
	if (bytes.byteLength !== expected)
		throw new Error("profile capture length does not match its header");
	const frames: Array<RawFrame> = [];
	const frameBase = headerBytes + recordCount * CAPTURE_RECORD_BYTES;
	for (let index = 0; index < frameCount; index++) {
		const offset = frameBase + index * frameBytes;
		frames.push({
			functionIndex: view.getInt32(offset, true),
			positionId: view.getInt32(offset + 4, true),
			siteId: schema === 1 ? -1 : view.getInt32(offset + 8, true),
		});
	}
	const records: Array<RawRecord> = [];
	for (let index = 0; index < recordCount; index++) {
		const offset = headerBytes + index * CAPTURE_RECORD_BYTES;
		const frameOffset = view.getUint32(offset + 32, true);
		const recordFrameCount = view.getUint32(offset + 36, true);
		if (frameOffset + recordFrameCount > frames.length) {
			throw new Error("profile capture record references frames outside the capture");
		}
		const frameOmission = schema >= 3 ? view.getUint32(offset + 4, true) : 0;
		records.push({
			kind: view.getUint8(offset),
			timestampNs: checkedNumber(view.getBigUint64(offset + 8, true), "timestamp"),
			value: checkedNumber(view.getBigUint64(offset + 16, true), "record value"),
			auxiliary: checkedNumber(view.getBigUint64(offset + 24, true), "record auxiliary"),
			omittedFrames: frameOmission & 0x3fff_ffff,
			depthTruncated: (frameOmission & 0x8000_0000) !== 0,
			capacityTruncated: (frameOmission & 0x4000_0000) !== 0,
			allocationStorage: schema >= 3 ? view.getUint8(offset + 1) : 0,
			allocationFamily: schema >= 3 ? view.getUint8(offset + 2) : 0,
			allocationObjectType: schema >= 3 ? view.getUint8(offset + 3) : 0xff,
			frames: frames.slice(frameOffset, frameOffset + recordFrameCount),
		});
	}
	return {
		schema: typedSchema,
		...(schema === 4
			? {
					captureIdentity: Buffer.from(bytes.subarray(48, 80)).toString("hex"),
				}
			: {}),
		intervalUs: view.getUint32(28, true),
		allocationIntervalBytes:
			schema >= 3
				? checkedNumber(view.getBigUint64(40, true), "allocation interval")
				: 65_536,
		allocationSampling: schema >= 3 ? "poisson" : "legacy-fixed",
		samplingClock: schema >= 3 ? "process-cpu" : "legacy-mixed",
		droppedRecords: view.getUint32(20, true),
		droppedFrames: view.getUint32(24, true),
		records,
	};
}

function emptyCompilerEvents(): CompilerEvents {
	return {
		executions: 0,
		fastPaths: 0,
		fallbacks: 0,
		allocationCount: 0,
		allocationRequestedBytes: 0,
		allocationChargedBytes: 0,
		boxing: 0,
		safepoints: 0,
		gc: 0,
		runtimeDispatch: 0,
		runtimeString: 0,
		runtimeRegExp: 0,
		runtimeHost: 0,
	};
}

function compilerV1EventsAt(view: DataView, offset: number): CompilerEvents {
	const events = emptyCompilerEvents();
	for (const [index, name] of COMPILER_V1_EVENT_NAMES.entries()) {
		const value = checkedNumber(
			view.getBigUint64(offset + index * 8, true),
			`compiler event ${name}`,
		);
		events[name] = value;
		if (name === "allocationRequestedBytes") events.allocationChargedBytes = value;
	}
	return events;
}

export function parseCompilerCapture(bytes: Uint8Array): CompilerCapture {
	if (bytes.byteLength < COMPILER_V1_HEADER_BYTES)
		throw new Error("compiler profile is truncated");
	const magic = Buffer.from(bytes.subarray(0, 8)).toString();
	if (
		magic !== "MALSITE1" &&
		magic !== "MALSITE2" &&
		magic !== "MALSITE3" &&
		magic !== "MALSITE4"
	)
		throw new Error("compiler profile has an unknown magic value");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const schema = view.getUint32(8, true);
	if (
		(magic === "MALSITE1" && schema !== 1) ||
		(magic === "MALSITE2" && schema !== 2) ||
		(magic === "MALSITE3" && schema !== 3) ||
		(magic === "MALSITE4" && schema !== 4)
	)
		throw new Error("compiler profile schema is unsupported");
	const trackedSiteCount = view.getUint32(12, true);
	const totalSiteCount = view.getUint32(16, true);
	const eventCount = view.getUint32(20, true);
	if (schema === 1) {
		if (eventCount !== COMPILER_V1_EVENT_NAMES.length)
			throw new Error("compiler profile event schema is unsupported");
		const eventBytes = eventCount * 8;
		const expected =
			COMPILER_V1_HEADER_BYTES + eventBytes + trackedSiteCount * eventBytes;
		if (bytes.byteLength !== expected)
			throw new Error("compiler profile length does not match its header");
		const unattributed = compilerV1EventsAt(view, COMPILER_V1_HEADER_BYTES);
		const bySite = Array.from({ length: trackedSiteCount }, (_, siteId) =>
			compilerV1EventsAt(view, COMPILER_V1_HEADER_BYTES + eventBytes * (siteId + 1)),
		);
		return {
			schema: 1,
			trackedSiteCount,
			totalSiteCount,
			unattributed,
			bySite,
			allocations: [],
		};
	}

	if (bytes.byteLength < COMPILER_V2_HEADER_BYTES)
		throw new Error("compiler profile is truncated");
	const eventNames = schema === 4 ? COMPILER_V4_EVENT_NAMES : COMPILER_V2_EVENT_NAMES;
	if (eventCount !== eventNames.length)
		throw new Error("compiler profile event schema is unsupported");
	const allocationCount = view.getUint32(24, true);
	const headerBytes = schema >= 3 ? COMPILER_V3_HEADER_BYTES : COMPILER_V2_HEADER_BYTES;
	if (bytes.byteLength < headerBytes) throw new Error("compiler profile is truncated");
	const eventBytes = eventCount * 8;
	const allocationBytes = allocationCount * 32;
	const expected =
		headerBytes + eventBytes + trackedSiteCount * eventBytes + allocationBytes;
	if (bytes.byteLength !== expected)
		throw new Error("compiler profile length does not match its header");
	const unattributed = emptyCompilerEvents();
	for (const [eventIndex, name] of eventNames.entries()) {
		unattributed[name] = checkedNumber(
			view.getBigUint64(headerBytes + eventIndex * 8, true),
			`compiler event ${name}`,
		);
	}
	const bySite = Array.from({ length: trackedSiteCount }, () => emptyCompilerEvents());
	const siteBase = headerBytes + eventBytes;
	for (const [eventIndex, name] of eventNames.entries()) {
		for (let siteId = 0; siteId < trackedSiteCount; siteId++) {
			bySite[siteId]![name] = checkedNumber(
				view.getBigUint64(siteBase + (eventIndex * trackedSiteCount + siteId) * 8, true),
				`compiler site ${siteId} event ${name}`,
			);
		}
	}
	const allocations: Array<CompilerAllocationCounter> = [];
	const allocationBase = siteBase + trackedSiteCount * eventBytes;
	for (let index = 0; index < allocationCount; index++) {
		const offset = allocationBase + index * 32;
		allocations.push({
			siteId: view.getInt32(offset, true),
			storage: view.getUint8(offset + 4),
			family: view.getUint8(offset + 5),
			objectType: view.getUint8(offset + 6),
			count: checkedNumber(view.getBigUint64(offset + 8, true), "allocation count"),
			requestedBytes: checkedNumber(
				view.getBigUint64(offset + 16, true),
				"allocation requested bytes",
			),
			chargedBytes: checkedNumber(
				view.getBigUint64(offset + 24, true),
				"allocation charged bytes",
			),
		});
	}
	return {
		schema: schema as 2 | 3 | 4,
		...(schema >= 3
			? { captureIdentity: Buffer.from(bytes.subarray(32, 64)).toString("hex") }
			: {}),
		trackedSiteCount,
		totalSiteCount,
		unattributed,
		bySite,
		allocations,
	};
}

function positionSiteIndex(prepared: PreparedProfile): Map<string, ProfileSite> {
	const result = new Map<string, ProfileSite>();
	const ambiguous = new Set<string>();
	for (const site of prepared.sites) {
		const key = `${site.functionIndex}:${site.positionId}`;
		if (ambiguous.has(key)) continue;
		if (result.has(key)) {
			result.delete(key);
			ambiguous.add(key);
		} else result.set(key, site);
	}
	return result;
}

function percentile(values: Array<number>, fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function cpuProfile(capture: RawCapture, prepared: PreparedProfile): object {
	const positionSites = positionSiteIndex(prepared);
	const nodes: Array<{
		id: number;
		callFrame: {
			functionName: string;
			scriptId: string;
			url: string;
			lineNumber: number;
			columnNumber: number;
		};
		children?: Array<number>;
	}> = [
		{
			id: 1,
			callFrame: {
				functionName: "(root)",
				scriptId: "0",
				url: "",
				lineNumber: -1,
				columnNumber: -1,
			},
		},
	];
	const nodeByStack = new Map<string, number>([["", 1]]);
	const samples: Array<number> = [];
	const timeDeltas: Array<number> = [];
	let previousUs = 0;
	for (const record of capture.records.filter((entry) => entry.kind === 1)) {
		let parent = 1;
		let stackKey = "";
		if (record.omittedFrames > 0) {
			stackKey = `/truncated:${record.omittedFrames}`;
			let id = nodeByStack.get(stackKey);
			if (id === undefined) {
				id = nodes.length + 1;
				nodes.push({
					id,
					callFrame: {
						functionName: `[truncated: ${record.omittedFrames} outer frames]`,
						scriptId: "0",
						url: "",
						lineNumber: -1,
						columnNumber: -1,
					},
				});
				nodeByStack.set(stackKey, id);
				const parentNode = nodes[parent - 1]!;
				(parentNode.children ??= []).push(id);
			}
			parent = id;
		}
		for (const frame of record.frames) {
			stackKey += `/${frame.functionIndex}:${frame.positionId}:${frame.siteId}`;
			let id = nodeByStack.get(stackKey);
			if (id === undefined) {
				id = nodes.length + 1;
				const site =
					prepared.sites[frame.siteId] ??
					positionSites.get(`${frame.functionIndex}:${frame.positionId}`);
				const fn = prepared.functions[frame.functionIndex];
				nodes.push({
					id,
					callFrame: {
						functionName: fn?.name ?? "<unknown>",
						scriptId: "0",
						url: site?.file ?? fn?.file ?? "<unknown>",
						lineNumber: (site?.line ?? 1) - 1,
						columnNumber: site?.column ?? 0,
					},
				});
				nodeByStack.set(stackKey, id);
				const parentNode = nodes[parent - 1]!;
				(parentNode.children ??= []).push(id);
			}
			parent = id;
		}
		const timestampUs = Math.floor(record.timestampNs / 1000);
		samples.push(parent);
		timeDeltas.push(Math.max(0, timestampUs - previousUs));
		previousUs = timestampUs;
	}
	return { nodes, startTime: 0, endTime: previousUs, samples, timeDeltas };
}

type ProfileQuality = "biased" | "insufficient" | "good";

function evidenceConfidence(
	count: number,
	quality: ProfileQuality,
): "none" | "low" | "medium" | "high" {
	if (count === 0) return "none";
	if (quality !== "good") return "low";
	return count >= 100 ? "high" : count >= 20 ? "medium" : "low";
}

function allocationStorageName(value: number): string {
	return ALLOCATION_STORAGE_NAMES[value] ?? `storage-${value}`;
}

function allocationFamilyName(value: number): string {
	return ALLOCATION_FAMILY_NAMES[value] ?? `family-${value}`;
}

function allocationSampleWeight(capture: RawCapture, record: RawRecord): number {
	if (capture.allocationSampling !== "poisson") return 0;
	const chargedBytes = record.auxiliary;
	if (chargedBytes <= 0 || capture.allocationIntervalBytes <= 0) return 0;
	const probability = -Math.expm1(-chargedBytes / capture.allocationIntervalBytes);
	return probability <= 0 ? 0 : 1 / probability;
}

function findings(
	capture: RawCapture,
	prepared: PreparedProfile,
	quality: ProfileQuality,
	compiler?: CompilerCapture,
): Array<ProfileFinding> {
	const positionSites = positionSiteIndex(prepared);
	interface FindingAggregate {
		siteId: number;
		cpuSamples: number;
		allocationSamples: number;
		sampledBytes: number;
		sampledChargedBytes: number;
		estimatedRequestedBytes: number;
		estimatedChargedBytes: number;
		allocationFamilies: Map<
			string,
			{
				storage: string;
				family: string;
				samples: number;
				requestedBytes: number;
				chargedBytes: number;
				estimatedChargedBytes: number;
			}
		>;
	}
	const bySite = new Map<number, FindingAggregate>();
	const decisionsBySite = new Map<number, Array<CompilerRemark>>();
	for (const decision of prepared.remarks) {
		const decisions = decisionsBySite.get(decision.siteId);
		if (decisions === undefined) decisionsBySite.set(decision.siteId, [decision]);
		else decisions.push(decision);
	}
	const compilerAllocationsBySite = new Map<number, Array<CompilerAllocationCounter>>();
	for (const allocation of compiler?.allocations ?? []) {
		const allocations = compilerAllocationsBySite.get(allocation.siteId);
		if (allocations === undefined) {
			compilerAllocationsBySite.set(allocation.siteId, [allocation]);
		} else {
			allocations.push(allocation);
		}
	}
	const cpuTotal = capture.records.filter((record) => record.kind === 1).length;
	for (const record of capture.records) {
		const leaf = record.frames.at(-1);
		if (leaf === undefined) continue;
		const site =
			prepared.sites[leaf.siteId] ??
			positionSites.get(`${leaf.functionIndex}:${leaf.positionId}`);
		if (site === undefined) continue;
		let value = bySite.get(site.id);
		if (value === undefined) {
			value = {
				siteId: site.id,
				cpuSamples: 0,
				allocationSamples: 0,
				sampledBytes: 0,
				sampledChargedBytes: 0,
				estimatedRequestedBytes: 0,
				estimatedChargedBytes: 0,
				allocationFamilies: new Map(),
			};
			bySite.set(site.id, value);
		}
		if (record.kind === 1) {
			value.cpuSamples++;
		} else if (record.kind === 2) {
			value.allocationSamples++;
			value.sampledBytes += record.value;
			value.sampledChargedBytes += record.auxiliary;
			const weight = allocationSampleWeight(capture, record);
			value.estimatedRequestedBytes += record.value * weight;
			value.estimatedChargedBytes += record.auxiliary * weight;
			const storage = allocationStorageName(record.allocationStorage);
			const family = allocationFamilyName(record.allocationFamily);
			const key = `${storage}:${family}`;
			let allocation = value.allocationFamilies.get(key);
			if (allocation === undefined) {
				allocation = {
					storage,
					family,
					samples: 0,
					requestedBytes: 0,
					chargedBytes: 0,
					estimatedChargedBytes: 0,
				};
				value.allocationFamilies.set(key, allocation);
			}
			allocation.samples++;
			allocation.requestedBytes += record.value;
			allocation.chargedBytes += record.auxiliary;
			allocation.estimatedChargedBytes += record.auxiliary * weight;
		}
	}
	for (let siteId = 0; siteId < (compiler?.bySite.length ?? 0); siteId++) {
		const events = compiler!.bySite[siteId]!;
		if (Object.values(events).every((value) => value === 0)) continue;
		if (!bySite.has(siteId)) {
			bySite.set(siteId, {
				siteId,
				cpuSamples: 0,
				allocationSamples: 0,
				sampledBytes: 0,
				sampledChargedBytes: 0,
				estimatedRequestedBytes: 0,
				estimatedChargedBytes: 0,
				allocationFamilies: new Map(),
			});
		}
	}
	return [...bySite.values()]
		.map((value) => {
			const site = prepared.sites[value.siteId]!;
			const cpuConfidence = evidenceConfidence(value.cpuSamples, quality);
			const allocationConfidence = evidenceConfidence(value.allocationSamples, quality);
			const decisions = [...(decisionsBySite.get(site.id) ?? [])].sort((left, right) => {
				const rank: Record<CompilerRemark["outcome"], number> = {
					applied: 0,
					elided: 0,
					guarded: 1,
					retained: 2,
					declined: 3,
					fallback: 3,
				};
				return rank[left.outcome] - rank[right.outcome];
			});
			const rawCompiler = compiler?.bySite[value.siteId];
			const compilerEvents =
				rawCompiler === undefined
					? undefined
					: {
							...rawCompiler,
							fastPaths:
								rawCompiler.fastPaths +
								(decisions.some(
									(decision) =>
										decision.outcome === "applied" ||
										decision.outcome === "elided" ||
										decision.outcome === "guarded",
								)
									? Math.max(0, rawCompiler.executions - rawCompiler.fallbacks)
									: 0),
						};
			return {
				siteId: value.siteId,
				cpuSamples: value.cpuSamples,
				allocationSamples: value.allocationSamples,
				sampledBytes: value.sampledBytes,
				sampledChargedBytes: value.sampledChargedBytes,
				estimatedRequestedBytes: value.estimatedRequestedBytes,
				estimatedChargedBytes: value.estimatedChargedBytes,
				allocationEstimated: capture.allocationSampling === "poisson",
				allocationFamilies: [...value.allocationFamilies.values()].sort(
					(left, right) => right.estimatedChargedBytes - left.estimatedChargedBytes,
				),
				logicalId: site.logicalId,
				originId: site.originId,
				instanceId: site.instanceId,
				regionId: site.regionId,
				operation: site.operation,
				functionIndex: site.functionIndex,
				instructionIndex: site.instructionIndex,
				file: site.file,
				line: site.line,
				column: site.column,
				cpuShare: cpuTotal === 0 ? 0 : value.cpuSamples / cpuTotal,
				remarks: decisions.map((remark) => remark.code),
				decisions,
				...(compilerEvents === undefined ? {} : { compiler: compilerEvents }),
				...(compiler === undefined
					? {}
					: {
							compilerAllocations: compilerAllocationsBySite.get(site.id) ?? [],
						}),
				cpuConfidence,
				allocationConfidence,
			};
		})
		.sort(
			(left, right) =>
				right.cpuSamples - left.cpuSamples ||
				(right.compiler?.executions ?? 0) - (left.compiler?.executions ?? 0) ||
				right.sampledChargedBytes - left.sampledChargedBytes,
		);
}

function atomicJson(file: string, value: unknown, compact = false): void {
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(
		temporary,
		`${JSON.stringify(value, undefined, compact ? undefined : 2)}\n`,
	);
	renameSync(temporary, file);
}

function profileQuality(
	capture: RawCapture,
	gc: GcSummary,
	phases: ProfilePhaseSummary,
): ProfileQuality {
	const cpuRecords = capture.records.filter((record) => record.kind === 1);
	const allocationRecords = capture.records.filter((record) => record.kind === 2);
	const delays = cpuRecords.map((record) => record.auxiliary / 1e6);
	return capture.droppedFrames > 0 ||
		capture.droppedRecords > 0 ||
		gc.incompleteEvents > 0 ||
		phases.incompleteEvents > 0 ||
		percentile(delays, 0.99) > (capture.intervalUs / 1000) * 4
		? "biased"
		: cpuRecords.length < 20 && allocationRecords.length < 20
			? "insufficient"
			: "good";
}

interface AllocationFamilySummary {
	storage: string;
	family: string;
	samples: number;
	requestedBytes: number;
	chargedBytes: number;
	estimatedRequestedBytes: number;
	estimatedChargedBytes: number;
}

interface CompilerAllocationFamilySummary {
	storage: string;
	family: string;
	count: number;
	requestedBytes: number;
	chargedBytes: number;
}

interface GcSummary {
	collections: number;
	major: number;
	minor: number;
	totalPauseMs: number;
	maxPauseMs: number;
	incompleteEvents: number;
}

export interface ProfilePhaseTiming {
	id: number;
	name: string;
	spans: number;
	inclusiveMs: number;
	selfMs: number;
	maxInclusiveMs: number;
	cpuSamples: number;
	allocationSamples: number;
	estimatedChargedBytes: number;
	gcCollections: number;
	gcPauseMs: number;
}

export interface ProfilePhaseSummary {
	clock: "monotonic-wall";
	evidenceAttribution: "innermost";
	unphased: {
		cpuSamples: number;
		allocationSamples: number;
		estimatedChargedBytes: number;
		gcCollections: number;
		gcPauseMs: number;
	};
	spans: number;
	measuredWallMs: number;
	incompleteEvents: number;
	timings: Array<ProfilePhaseTiming>;
}

export interface ProfileManifest {
	schema: 4;
	status: "complete";
	command: string;
	mode: PreparedProfile["mode"];
	buildId: string;
	captureIdentity: string;
	entrypoint: string;
	captureSchema: number;
	intervalUs: number;
	clocks: { timeline: "monotonic"; sampling: RawCapture["samplingClock"] };
	cpuSamples: number;
	allocationSamples: number;
	allocation: {
		sampling: RawCapture["allocationSampling"];
		intervalBytes: number;
		sampledRequestedBytes: number;
		sampledChargedBytes: number;
		estimatedRequestedBytes: number;
		estimatedChargedBytes: number;
		families: Array<AllocationFamilySummary>;
	};
	gc: GcSummary;
	phases: ProfilePhaseSummary;
	attribution: {
		cpuSamples: number;
		unattributedCpuSamples: number;
		allocationSamples: number;
		unattributedAllocationSamples: number;
		sampledTriggerBytes: number;
		attributedSampledTriggerBytes: number;
		chargedTriggerBytes: number;
		attributedChargedTriggerBytes: number;
	};
	compiler?: {
		trackedSiteCount: number;
		totalSiteCount: number;
		reportedSiteCount: number;
		omittedZeroEventSiteCount: number;
		unattributed: CompilerEvents;
		allocationEntries: number;
		executions: number;
		fallbacks: number;
		boxing: number;
		safepoints: number;
		gc: number;
		runtimeDispatch: number;
		runtimeString: number;
		runtimeRegExp: number;
		runtimeHost: number;
		allocationCount: number;
		requestedBytes: number;
		chargedBytes: number;
		families: Array<CompilerAllocationFamilySummary>;
		overflow: CompilerAllocationCounter | null;
	};
	droppedRecords: number;
	droppedFrames: number;
	stackTruncation: {
		records: number;
		omittedFrames: number;
		depthLimitedRecords: number;
		capacityLimitedRecords: number;
	};
	sampleDelayMs: { median: number; p99: number };
	quality: ProfileQuality;
}

function summarizeGc(records: Array<RawRecord>): GcSummary {
	const begins: Array<{ timestampNs: number; major: boolean }> = [];
	let collections = 0;
	let major = 0;
	let minor = 0;
	let totalPauseMs = 0;
	let maxPauseMs = 0;
	let unmatchedEnds = 0;
	for (const record of records) {
		if (record.kind === 3) {
			const isMajor = record.value === 1;
			begins.push({ timestampNs: record.timestampNs, major: isMajor });
			collections++;
			if (isMajor) major++;
			else minor++;
		} else if (record.kind === 4) {
			const begin = begins.pop();
			if (begin === undefined) {
				unmatchedEnds++;
				continue;
			}
			const pauseMs = Math.max(0, record.timestampNs - begin.timestampNs) / 1e6;
			totalPauseMs += pauseMs;
			maxPauseMs = Math.max(maxPauseMs, pauseMs);
		}
	}
	return {
		collections,
		major,
		minor,
		totalPauseMs,
		maxPauseMs,
		incompleteEvents: begins.length + unmatchedEnds,
	};
}

function summarizePhases(capture: RawCapture): ProfilePhaseSummary {
	interface OpenPhase {
		id: number;
		startedAtNs: number;
		childNs: number;
	}
	interface AccumulatedPhase {
		id: number;
		spans: number;
		inclusiveNs: number;
		selfNs: number;
		maxInclusiveNs: number;
	}
	interface PhaseEvidence {
		cpuSamples: number;
		allocationSamples: number;
		estimatedChargedBytes: number;
		gcCollections: number;
		gcPauseNs: number;
	}
	const open: Array<OpenPhase> = [];
	const accumulated = new Map<number, AccumulatedPhase>();
	const evidence = new Map<number, PhaseEvidence>();
	const unphased: PhaseEvidence = {
		cpuSamples: 0,
		allocationSamples: 0,
		estimatedChargedBytes: 0,
		gcCollections: 0,
		gcPauseNs: 0,
	};
	const gcBegins: Array<{ timestampNs: number; phaseId?: number }> = [];
	let measuredWallNs = 0;
	let incompleteEvents = 0;
	let spans = 0;
	const phaseEvidence = (id: number): PhaseEvidence => {
		let value = evidence.get(id);
		if (value === undefined) {
			value = {
				cpuSamples: 0,
				allocationSamples: 0,
				estimatedChargedBytes: 0,
				gcCollections: 0,
				gcPauseNs: 0,
			};
			evidence.set(id, value);
		}
		return value;
	};
	const ordered = capture.records
		.map((record, index) => ({ record, index }))
		.sort(
			(left, right) =>
				left.record.timestampNs - right.record.timestampNs || left.index - right.index,
		);
	for (const { record } of ordered) {
		if (record.kind === 5) {
			open.push({
				id: record.value,
				startedAtNs: record.timestampNs,
				childNs: 0,
			});
			continue;
		}
		const activePhaseId = open.at(-1)?.id;
		if (record.kind === 1) {
			(activePhaseId === undefined ? unphased : phaseEvidence(activePhaseId))
				.cpuSamples++;
			continue;
		}
		if (record.kind === 2) {
			const activeEvidence =
				activePhaseId === undefined ? unphased : phaseEvidence(activePhaseId);
			activeEvidence.allocationSamples++;
			activeEvidence.estimatedChargedBytes +=
				record.auxiliary * allocationSampleWeight(capture, record);
			continue;
		}
		if (record.kind === 3) {
			gcBegins.push({
				timestampNs: record.timestampNs,
				...(activePhaseId === undefined ? {} : { phaseId: activePhaseId }),
			});
			continue;
		}
		if (record.kind === 4) {
			const begin = gcBegins.pop();
			if (begin !== undefined) {
				const activeEvidence =
					begin.phaseId === undefined ? unphased : phaseEvidence(begin.phaseId);
				activeEvidence.gcCollections++;
				activeEvidence.gcPauseNs += Math.max(0, record.timestampNs - begin.timestampNs);
			}
			continue;
		}
		if (record.kind !== 6) continue;
		const active = open.at(-1);
		if (active === undefined || active.id !== record.value) {
			incompleteEvents++;
			continue;
		}
		open.pop();
		const inclusiveNs = Math.max(0, record.timestampNs - active.startedAtNs);
		const selfNs = Math.max(0, inclusiveNs - active.childNs);
		let summary = accumulated.get(active.id);
		if (summary === undefined) {
			summary = {
				id: active.id,
				spans: 0,
				inclusiveNs: 0,
				selfNs: 0,
				maxInclusiveNs: 0,
			};
			accumulated.set(active.id, summary);
		}
		summary.spans++;
		summary.inclusiveNs += inclusiveNs;
		summary.selfNs += selfNs;
		summary.maxInclusiveNs = Math.max(summary.maxInclusiveNs, inclusiveNs);
		spans++;
		const parent = open.at(-1);
		if (parent === undefined) measuredWallNs += inclusiveNs;
		else parent.childNs += inclusiveNs;
	}
	incompleteEvents += open.length;
	return {
		clock: "monotonic-wall",
		evidenceAttribution: "innermost",
		unphased: {
			cpuSamples: unphased.cpuSamples,
			allocationSamples: unphased.allocationSamples,
			estimatedChargedBytes: unphased.estimatedChargedBytes,
			gcCollections: unphased.gcCollections,
			gcPauseMs: unphased.gcPauseNs / 1e6,
		},
		spans,
		measuredWallMs: measuredWallNs / 1e6,
		incompleteEvents,
		timings: [...accumulated.values()]
			.map((phase) => {
				const phaseEvidence = evidence.get(phase.id);
				return {
					id: phase.id,
					name: profilePhaseName(phase.id),
					spans: phase.spans,
					inclusiveMs: phase.inclusiveNs / 1e6,
					selfMs: phase.selfNs / 1e6,
					maxInclusiveMs: phase.maxInclusiveNs / 1e6,
					cpuSamples: phaseEvidence?.cpuSamples ?? 0,
					allocationSamples: phaseEvidence?.allocationSamples ?? 0,
					estimatedChargedBytes: phaseEvidence?.estimatedChargedBytes ?? 0,
					gcCollections: phaseEvidence?.gcCollections ?? 0,
					gcPauseMs: (phaseEvidence?.gcPauseNs ?? 0) / 1e6,
				};
			})
			.sort((left, right) => right.inclusiveMs - left.inclusiveMs || left.id - right.id),
	};
}

function summarizeCompilerAllocations(
	allocations: Array<CompilerAllocationCounter>,
): Array<CompilerAllocationFamilySummary> {
	const families = new Map<string, CompilerAllocationFamilySummary>();
	for (const allocation of allocations) {
		const storage = allocationStorageName(allocation.storage);
		const family = allocationFamilyName(allocation.family);
		const key = `${storage}:${family}`;
		let summary = families.get(key);
		if (summary === undefined) {
			summary = {
				storage,
				family,
				count: 0,
				requestedBytes: 0,
				chargedBytes: 0,
			};
			families.set(key, summary);
		}
		summary.count += allocation.count;
		summary.requestedBytes += allocation.requestedBytes;
		summary.chargedBytes += allocation.chargedBytes;
	}
	return [...families.values()].sort(
		(left, right) => right.chargedBytes - left.chargedBytes,
	);
}

function compilerEventTotal(compiler: CompilerCapture, event: CompilerEventName): number {
	return (
		compiler.unattributed[event] +
		compiler.bySite.reduce((total, events) => total + events[event], 0)
	);
}

function summarizeAllocationSamples(
	capture: RawCapture,
	records: Array<RawRecord>,
): ProfileManifest["allocation"] {
	const families = new Map<string, AllocationFamilySummary>();
	let sampledRequestedBytes = 0;
	let sampledChargedBytes = 0;
	let estimatedRequestedBytes = 0;
	let estimatedChargedBytes = 0;
	for (const record of records) {
		const weight = allocationSampleWeight(capture, record);
		const storage = allocationStorageName(record.allocationStorage);
		const family = allocationFamilyName(record.allocationFamily);
		const key = `${storage}:${family}`;
		let summary = families.get(key);
		if (summary === undefined) {
			summary = {
				storage,
				family,
				samples: 0,
				requestedBytes: 0,
				chargedBytes: 0,
				estimatedRequestedBytes: 0,
				estimatedChargedBytes: 0,
			};
			families.set(key, summary);
		}
		summary.samples++;
		summary.requestedBytes += record.value;
		summary.chargedBytes += record.auxiliary;
		summary.estimatedRequestedBytes += record.value * weight;
		summary.estimatedChargedBytes += record.auxiliary * weight;
		sampledRequestedBytes += record.value;
		sampledChargedBytes += record.auxiliary;
		estimatedRequestedBytes += record.value * weight;
		estimatedChargedBytes += record.auxiliary * weight;
	}
	return {
		sampling: capture.allocationSampling,
		intervalBytes: capture.allocationIntervalBytes,
		sampledRequestedBytes,
		sampledChargedBytes,
		estimatedRequestedBytes,
		estimatedChargedBytes,
		families: [...families.values()].sort(
			(left, right) => right.estimatedChargedBytes - left.estimatedChargedBytes,
		),
	};
}

export function finalizeProfileCapture(
	directory: string,
	prepared: PreparedProfile,
	command: string,
): { findings: Array<ProfileFinding>; manifest: ProfileManifest } {
	const capture = parseProfileCapture(readFileSync(path.join(directory, "capture.bin")));
	let captureIdentity: string;
	if (capture.schema === 4) {
		captureIdentity = validatedCaptureIdentity(prepared);
		if (capture.captureIdentity !== captureIdentity) {
			throw new Error("profile capture identity does not match its metadata and build");
		}
	} else {
		// Legacy raw captures predate identity binding. Retain read compatibility,
		// but never claim an unverified identity in their completed manifest.
		captureIdentity = "legacy-unbound";
	}
	const compilerPath = path.join(directory, "capture.bin.compiler");
	if (prepared.mode === "compiler" && !existsSync(compilerPath)) {
		throw new Error("compiler profile counter artifact is missing");
	}
	const compiler = existsSync(compilerPath)
		? parseCompilerCapture(readFileSync(compilerPath))
		: undefined;
	if (capture.schema === 4 && compiler !== undefined) {
		if (compiler.schema < 3 || compiler.captureIdentity !== captureIdentity) {
			throw new Error(
				"compiler profile identity does not match the sampling capture, metadata, and build",
			);
		}
	}
	const cpuRecords = capture.records.filter((record) => record.kind === 1);
	const allocationRecords = capture.records.filter((record) => record.kind === 2);
	const delays = cpuRecords.map((record) => record.auxiliary / 1e6);
	const allocation = summarizeAllocationSamples(capture, allocationRecords);
	const gc = summarizeGc(capture.records);
	const phases = summarizePhases(capture);
	const quality = profileQuality(capture, gc, phases);
	const ranked = findings(capture, prepared, quality, compiler);
	atomicJson(path.join(directory, "cpu.cpuprofile"), cpuProfile(capture, prepared));
	atomicJson(
		path.join(directory, "timeline.json"),
		capture.records
			.filter(
				(record) =>
					record.kind === 3 ||
					record.kind === 4 ||
					record.kind === 5 ||
					record.kind === 6,
			)
			.map((record) => ({
				name:
					record.kind === 3 || record.kind === 4 ? "GC" : profilePhaseName(record.value),
				cat: record.kind === 3 || record.kind === 4 ? "maligator.gc" : "maligator.phase",
				ph: record.kind === 3 || record.kind === 5 ? "B" : "E",
				ts: record.timestampNs / 1000,
				pid: 1,
				tid: 1,
				args:
					record.kind === 3 || record.kind === 4
						? { major: record.value === 1 }
						: { id: record.value },
			})),
	);
	atomicJson(path.join(directory, "phases.json"), { schema: 2, ...phases });
	atomicJson(
		path.join(directory, "allocations.json"),
		ranked.filter((finding) => finding.allocationSamples > 0),
	);
	const compilerFindings = ranked.filter((finding) => finding.compiler !== undefined);
	if (compiler !== undefined) {
		atomicJson(
			path.join(directory, "compiler.json"),
			{
				schema: 4,
				trackedSiteCount: compiler.trackedSiteCount,
				totalSiteCount: compiler.totalSiteCount,
				reportedSiteCount: compilerFindings.length,
				omittedZeroEventSiteCount: compiler.trackedSiteCount - compilerFindings.length,
				unattributed: compiler.unattributed,
				allocations: compiler.allocations.map((allocation) => ({
					...allocation,
					storageName: allocationStorageName(allocation.storage),
					familyName: allocationFamilyName(allocation.family),
				})),
				sites: compilerFindings.map((finding) => ({
					siteId: finding.siteId,
					logicalId: finding.logicalId,
					originId: finding.originId,
					instanceId: finding.instanceId,
					regionId: finding.regionId,
					file: finding.file,
					line: finding.line,
					column: finding.column,
					functionIndex: finding.functionIndex,
					instructionIndex: finding.instructionIndex,
					operation: finding.operation,
					decisions: finding.decisions,
					events: finding.compiler,
					allocations: finding.compilerAllocations?.map((allocation) => ({
						...allocation,
						storageName: allocationStorageName(allocation.storage),
						familyName: allocationFamilyName(allocation.family),
					})),
				})),
			},
			true,
		);
	}
	writeFileSync(
		path.join(directory, "remarks.jsonl"),
		prepared.remarks.map((remark) => JSON.stringify(remark)).join("\n") +
			(prepared.remarks.length === 0 ? "" : "\n"),
	);
	atomicJson(
		path.join(directory, "summary.json"),
		{
			schema: 3,
			findings: ranked,
		},
		true,
	);
	const truncatedRecords = capture.records.filter((record) => record.omittedFrames > 0);
	const compilerOverflow =
		compiler?.allocations.find((entry) => entry.siteId === -2) ?? null;
	const manifest: ProfileManifest = {
		schema: 4,
		status: "complete",
		command,
		mode: prepared.mode,
		buildId: prepared.buildId,
		captureIdentity,
		entrypoint: prepared.entrypoint,
		captureSchema: capture.schema,
		intervalUs: capture.intervalUs,
		clocks: { timeline: "monotonic", sampling: capture.samplingClock },
		cpuSamples: cpuRecords.length,
		allocationSamples: allocationRecords.length,
		allocation,
		gc,
		phases,
		attribution: {
			cpuSamples: ranked.reduce((total, finding) => total + finding.cpuSamples, 0),
			unattributedCpuSamples:
				cpuRecords.length -
				ranked.reduce((total, finding) => total + finding.cpuSamples, 0),
			allocationSamples: ranked.reduce(
				(total, finding) => total + finding.allocationSamples,
				0,
			),
			unattributedAllocationSamples:
				allocationRecords.length -
				ranked.reduce((total, finding) => total + finding.allocationSamples, 0),
			sampledTriggerBytes: allocationRecords.reduce(
				(total, record) => total + record.value,
				0,
			),
			attributedSampledTriggerBytes: ranked.reduce(
				(total, finding) => total + finding.sampledBytes,
				0,
			),
			chargedTriggerBytes: allocationRecords.reduce(
				(total, record) => total + record.auxiliary,
				0,
			),
			attributedChargedTriggerBytes: ranked.reduce(
				(total, finding) => total + finding.sampledChargedBytes,
				0,
			),
		},
		compiler:
			compiler === undefined
				? undefined
				: {
						trackedSiteCount: compiler.trackedSiteCount,
						totalSiteCount: compiler.totalSiteCount,
						reportedSiteCount: compilerFindings.length,
						omittedZeroEventSiteCount:
							compiler.trackedSiteCount - compilerFindings.length,
						unattributed: compiler.unattributed,
						allocationEntries: compiler.allocations.length,
						executions: compilerEventTotal(compiler, "executions"),
						fallbacks: compilerEventTotal(compiler, "fallbacks"),
						boxing: compilerEventTotal(compiler, "boxing"),
						safepoints: compilerEventTotal(compiler, "safepoints"),
						gc: compilerEventTotal(compiler, "gc"),
						runtimeDispatch: compilerEventTotal(compiler, "runtimeDispatch"),
						runtimeString: compilerEventTotal(compiler, "runtimeString"),
						runtimeRegExp: compilerEventTotal(compiler, "runtimeRegExp"),
						runtimeHost: compilerEventTotal(compiler, "runtimeHost"),
						allocationCount: compilerEventTotal(compiler, "allocationCount"),
						requestedBytes: compilerEventTotal(compiler, "allocationRequestedBytes"),
						chargedBytes: compilerEventTotal(compiler, "allocationChargedBytes"),
						families: summarizeCompilerAllocations(compiler.allocations),
						overflow: compilerOverflow,
					},
		droppedRecords: capture.droppedRecords,
		droppedFrames: capture.droppedFrames,
		stackTruncation: {
			records: truncatedRecords.length,
			omittedFrames: truncatedRecords.reduce(
				(total, record) => total + record.omittedFrames,
				0,
			),
			depthLimitedRecords: truncatedRecords.filter((record) => record.depthTruncated)
				.length,
			capacityLimitedRecords: truncatedRecords.filter(
				(record) => record.capacityTruncated,
			).length,
		},
		sampleDelayMs: {
			median: percentile(delays, 0.5),
			p99: percentile(delays, 0.99),
		},
		quality,
	};
	// Completeness marker is intentionally published last.
	atomicJson(path.join(directory, "manifest.json"), manifest);
	return { findings: ranked, manifest };
}

export function formatProfileFindings(
	values: Array<ProfileFinding>,
	limit = 7,
): Array<string> {
	if (values.length === 0) return ["  No source-attributed samples were captured."];
	const displayed = values.slice(0, limit);
	const duplicateSources = duplicateSourceOperations(displayed);
	return displayed.flatMap((finding, index) => {
		const primaryDecision = finding.decisions[0];
		const evidence = [
			finding.cpuSamples > 0
				? `${(finding.cpuShare * 100).toFixed(1)}% CPU (${finding.cpuSamples} samples, ${finding.cpuConfidence})`
				: undefined,
			finding.allocationSamples > 0
				? `${finding.allocationSamples} allocation samples · ${formatBytes(
						finding.allocationEstimated
							? finding.estimatedChargedBytes
							: finding.sampledChargedBytes,
					)} ${finding.allocationEstimated ? "estimated charged" : "sampled trigger"} (${finding.allocationConfidence})`
				: undefined,
			finding.compiler === undefined
				? undefined
				: `${formatCount(finding.compiler.executions)} exact · ${formatCount(
						finding.compiler.fastPaths,
					)} fast · ${formatCount(finding.compiler.fallbacks)} fallback · ${formatBytes(
						finding.compiler.allocationChargedBytes,
					)} charged`,
		]
			.filter((value) => value !== undefined)
			.join(" · ");
		const result = [
			`  ${index + 1}. ${finding.file}:${finding.line}:${finding.column + 1} · ${finding.operation}${formatSiteDisambiguator(
				finding,
				duplicateSources,
			)}`,
			`     ${evidence}`,
		];
		if (primaryDecision !== undefined) {
			result.push(
				`     ${REMARK_EXPLANATIONS[primaryDecision.code] ?? primaryDecision.code}${
					(primaryDecision.reasonCode ?? primaryDecision.reason) === undefined
						? ""
						: ` [${primaryDecision.reasonCode ?? primaryDecision.reason}]`
				}`,
			);
		}
		return result;
	});
}

function sourceOperationKey(finding: ProfileFinding): string {
	return JSON.stringify([finding.file, finding.line, finding.column, finding.operation]);
}

function duplicateSourceOperations(values: Array<ProfileFinding>): Set<string> {
	const counts = new Map<string, number>();
	for (const finding of values) {
		const key = sourceOperationKey(finding);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return new Set(
		[...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key),
	);
}

function formatSiteDisambiguator(
	finding: ProfileFinding,
	duplicateSources: Set<string>,
): string {
	return duplicateSources.has(sourceOperationKey(finding))
		? ` · site ${finding.siteId}`
		: "";
}

function findingDecisionLabel(finding: ProfileFinding): string | undefined {
	const decision = finding.decisions[0];
	if (decision === undefined) return undefined;
	return `${decision.code}${
		(decision.reasonCode ?? decision.reason) === undefined
			? ""
			: ` [${decision.reasonCode ?? decision.reason}]`
	}`;
}

function formatExactFallbackFindings(
	values: Array<ProfileFinding>,
	limit: number,
): Array<string> {
	const displayed = values
		.filter((finding) => (finding.compiler?.fallbacks ?? 0) > 0)
		.sort(
			(left, right) =>
				(right.compiler?.fallbacks ?? 0) - (left.compiler?.fallbacks ?? 0) ||
				left.siteId - right.siteId,
		)
		.slice(0, limit);
	const duplicateSources = duplicateSourceOperations(displayed);
	return displayed.map((finding, index) => {
		const compiler = finding.compiler!;
		const rate =
			compiler.executions === 0
				? "execution count unavailable"
				: `${((compiler.fallbacks / compiler.executions) * 100).toFixed(1)}%`;
		const decision = findingDecisionLabel(finding);
		return `  ${index + 1}. ${finding.file}:${finding.line}:${finding.column + 1} · ${finding.operation}${formatSiteDisambiguator(
			finding,
			duplicateSources,
		)} · ${formatCount(
			compiler.fallbacks,
		)} fallback / ${formatCount(compiler.executions)} executions (${rate})${
			decision === undefined ? "" : ` · ${decision}`
		}`;
	});
}

function formatExactRuntimeFindings(
	values: Array<ProfileFinding>,
	event: "runtimeDispatch" | "runtimeString" | "runtimeRegExp" | "runtimeHost",
	label: string,
	limit: number,
): Array<string> {
	const sources = new Map<
		string,
		{ finding: ProfileFinding; entries: number; generatedSites: number }
	>();
	for (const finding of values) {
		const entries = finding.compiler?.[event] ?? 0;
		if (entries === 0) continue;
		const key = sourceOperationKey(finding);
		const source = sources.get(key);
		if (source === undefined) {
			sources.set(key, { finding, entries, generatedSites: 1 });
		} else {
			source.entries += entries;
			source.generatedSites++;
			if (finding.siteId < source.finding.siteId) source.finding = finding;
		}
	}
	return [...sources.values()]
		.sort(
			(left, right) =>
				right.entries - left.entries || left.finding.siteId - right.finding.siteId,
		)
		.slice(0, limit)
		.map(
			(source, index) =>
				`  ${index + 1}. ${source.finding.file}:${source.finding.line}:${source.finding.column + 1} · ${source.finding.operation} · ${formatCount(
					source.entries,
				)} ${label} ${source.entries === 1 ? "entry" : "entries"}${
					source.generatedSites === 1
						? ""
						: ` · ${formatCount(source.generatedSites)} generated sites`
				}`,
		);
}

function formatExactAllocationFindings(
	values: Array<ProfileFinding>,
	limit: number,
): Array<string> {
	const displayed = values
		.filter((finding) => (finding.compiler?.allocationChargedBytes ?? 0) > 0)
		.sort(
			(left, right) =>
				(right.compiler?.allocationChargedBytes ?? 0) -
					(left.compiler?.allocationChargedBytes ?? 0) || left.siteId - right.siteId,
		)
		.slice(0, limit);
	const duplicateSources = duplicateSourceOperations(displayed);
	return displayed.map((finding, index) => {
		const compiler = finding.compiler!;
		const family = finding.compilerAllocations
			?.filter((allocation) => allocation.chargedBytes > 0)
			.sort((left, right) => right.chargedBytes - left.chargedBytes)[0];
		return `  ${index + 1}. ${finding.file}:${finding.line}:${finding.column + 1} · ${finding.operation}${formatSiteDisambiguator(
			finding,
			duplicateSources,
		)} · ${formatBytes(
			compiler.allocationChargedBytes,
		)} charged / ${formatCount(compiler.allocationCount)} allocations${
			family === undefined
				? ""
				: ` · top ${allocationFamilyName(family.family)}/${allocationStorageName(
						family.storage,
					)} ${formatBytes(family.chargedBytes)}`
		}`;
	});
}

function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0 B";
	const units = ["B", "KiB", "MiB", "GiB"];
	let scaled = value;
	let unit = 0;
	while (scaled >= 1024 && unit < units.length - 1) {
		scaled /= 1024;
		unit++;
	}
	return `${scaled >= 10 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`;
}

function formatCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatDuration(valueMs: number): string {
	if (valueMs >= 1000) return `${(valueMs / 1000).toFixed(2)} s`;
	return `${valueMs.toFixed(valueMs < 10 ? 2 : 1)} ms`;
}

export function formatProfileReport(
	result: { findings: Array<ProfileFinding>; manifest: ProfileManifest },
	limit = 7,
): Array<string> {
	const { manifest } = result;
	const cpuAttributed =
		manifest.cpuSamples === 0 ? 0 : manifest.attribution.cpuSamples / manifest.cpuSamples;
	const allocationAttributed =
		manifest.allocationSamples === 0
			? 0
			: manifest.attribution.allocationSamples / manifest.allocationSamples;
	const lines = [
		`  Quality ${manifest.quality} · ${formatCount(manifest.cpuSamples)} CPU samples · ${formatCount(
			manifest.allocationSamples,
		)} allocation samples`,
		`  Sampling ${(manifest.intervalUs / 1000).toFixed(2)} ms ${manifest.clocks.sampling} CPU / ${formatBytes(
			manifest.allocation.intervalBytes,
		)} ${manifest.allocation.sampling} allocation · delay ${manifest.sampleDelayMs.median.toFixed(
			2,
		)} ms median / ${manifest.sampleDelayMs.p99.toFixed(2)} ms p99 · ${formatCount(
			manifest.droppedRecords,
		)} dropped records`,
		`  Attribution ${(cpuAttributed * 100).toFixed(1)}% CPU (${formatCount(
			manifest.attribution.unattributedCpuSamples,
		)} unattributed) / ${(allocationAttributed * 100).toFixed(
			1,
		)}% allocation (${formatCount(
			manifest.attribution.unattributedAllocationSamples,
		)} unattributed) · ${formatCount(
			manifest.stackTruncation.records,
		)} truncated stacks / ${formatCount(
			manifest.stackTruncation.omittedFrames,
		)} omitted stack frames`,
		`  GC ${formatCount(manifest.gc.collections)} collections (${formatCount(
			manifest.gc.major,
		)} major / ${formatCount(manifest.gc.minor)} minor) · ${manifest.gc.totalPauseMs.toFixed(
			2,
		)} ms total / ${manifest.gc.maxPauseMs.toFixed(2)} ms max${
			manifest.gc.incompleteEvents === 0
				? ""
				: ` · ${formatCount(manifest.gc.incompleteEvents)} unmatched events`
		}`,
	];
	if (manifest.allocationSamples > 0) {
		const estimate =
			manifest.allocation.sampling === "poisson"
				? `${formatBytes(manifest.allocation.estimatedChargedBytes)} estimated charged allocation traffic`
				: `${formatBytes(manifest.allocation.sampledChargedBytes)} sampled trigger traffic`;
		lines.push(
			`  Allocation ${estimate} · ${formatBytes(
				manifest.allocation.sampledRequestedBytes,
			)} requested / ${formatBytes(manifest.allocation.sampledChargedBytes)} charged in samples`,
		);
		const topFamilies = manifest.allocation.families
			.slice(0, 4)
			.map(
				(family) =>
					`${family.family}/${family.storage} ${formatBytes(
						family.estimatedChargedBytes || family.chargedBytes,
					)}`,
			)
			.join(" · ");
		if (topFamilies !== "") lines.push(`  Allocation families ${topFamilies}`);
	}
	if (manifest.phases.spans > 0 || manifest.phases.incompleteEvents > 0) {
		const unphasedEvidence = [
			manifest.phases.unphased.cpuSamples === 0
				? undefined
				: `${formatCount(manifest.phases.unphased.cpuSamples)} CPU`,
			manifest.phases.unphased.allocationSamples === 0
				? undefined
				: `${formatBytes(manifest.phases.unphased.estimatedChargedBytes)} allocation`,
			manifest.phases.unphased.gcCollections === 0
				? undefined
				: `${formatCount(manifest.phases.unphased.gcCollections)} GC / ${formatDuration(
						manifest.phases.unphased.gcPauseMs,
					)}`,
		].filter((value): value is string => value !== undefined);
		lines.push(
			`  Phases ${formatCount(manifest.phases.spans)} spans · ${formatDuration(
				manifest.phases.measuredWallMs,
			)} measured monotonic wall${
				manifest.phases.incompleteEvents === 0
					? ""
					: ` · ${formatCount(manifest.phases.incompleteEvents)} unmatched events`
			}${
				unphasedEvidence.length === 0
					? ""
					: ` · outside phases ${unphasedEvidence.join(" · ")}`
			}`,
		);
		if (manifest.phases.timings.length > 0) {
			lines.push("  Phase timing (inclusive / self; evidence uses innermost phase)");
			lines.push(
				...manifest.phases.timings.slice(0, limit).map((phase, index) => {
					const wallShare =
						manifest.phases.measuredWallMs === 0
							? 0
							: phase.inclusiveMs / manifest.phases.measuredWallMs;
					const evidence = [
						phase.cpuSamples === 0
							? undefined
							: `${formatCount(phase.cpuSamples)} CPU (${(
									(manifest.cpuSamples === 0
										? 0
										: phase.cpuSamples / manifest.cpuSamples) * 100
								).toFixed(1)}%)`,
						phase.allocationSamples === 0
							? undefined
							: `${formatBytes(phase.estimatedChargedBytes)} allocation (${(
									(manifest.allocation.estimatedChargedBytes === 0
										? 0
										: phase.estimatedChargedBytes /
											manifest.allocation.estimatedChargedBytes) * 100
								).toFixed(1)}%)`,
						phase.gcCollections === 0
							? undefined
							: `${formatCount(phase.gcCollections)} GC / ${formatDuration(
									phase.gcPauseMs,
								)}`,
					].filter((value): value is string => value !== undefined);
					return `  ${index + 1}. ${phase.name} · ${formatDuration(
						phase.inclusiveMs,
					)} / ${formatDuration(phase.selfMs)} · ${(wallShare * 100).toFixed(
						1,
					)}% wall · ${formatCount(phase.spans)} span${
						phase.spans === 1 ? "" : "s"
					}${evidence.length === 0 ? "" : ` · ${evidence.join(" · ")}`}`;
				}),
			);
		}
	}
	if (manifest.compiler !== undefined) {
		const fallbackRate =
			manifest.compiler.executions === 0
				? 0
				: manifest.compiler.fallbacks / manifest.compiler.executions;
		lines.push(
			`  Compiler ${formatCount(manifest.compiler.executions)} executions · ${formatCount(
				manifest.compiler.fallbacks,
			)} fallbacks (${(fallbackRate * 100).toFixed(2)}%) · ${formatBytes(
				manifest.compiler.chargedBytes,
			)} charged allocation`,
		);
		const runtimeEntries =
			manifest.compiler.runtimeDispatch +
			manifest.compiler.runtimeString +
			manifest.compiler.runtimeRegExp +
			manifest.compiler.runtimeHost;
		if (runtimeEntries > 0) {
			lines.push(
				`  Runtime ${formatCount(manifest.compiler.runtimeDispatch)} native dispatches · ${formatCount(
					manifest.compiler.runtimeString,
				)} string · ${formatCount(manifest.compiler.runtimeRegExp)} regexp · ${formatCount(
					manifest.compiler.runtimeHost,
				)} host entries`,
			);
		}
		const siteCoverage =
			manifest.compiler.totalSiteCount === 0
				? 1
				: manifest.compiler.trackedSiteCount / manifest.compiler.totalSiteCount;
		const attributedExecutions =
			manifest.compiler.executions - manifest.compiler.unattributed.executions;
		const executionAttribution =
			manifest.compiler.executions === 0
				? 1
				: attributedExecutions / manifest.compiler.executions;
		lines.push(
			`  Compiler coverage ${formatCount(manifest.compiler.trackedSiteCount)}/${formatCount(
				manifest.compiler.totalSiteCount,
			)} sites (${(siteCoverage * 100).toFixed(1)}%) · ${(
				executionAttribution * 100
			).toFixed(1)}% executions attributed (${formatCount(
				manifest.compiler.unattributed.executions,
			)} unattributed)`,
		);
		lines.push(
			`  Compiler rows ${formatCount(
				manifest.compiler.reportedSiteCount,
			)} evidence-bearing · ${formatCount(
				manifest.compiler.omittedZeroEventSiteCount,
			)} zero-event sites omitted`,
		);
		const compilerFamilies = manifest.compiler.families
			.slice(0, 4)
			.map(
				(family) =>
					`${family.family}/${family.storage} ${formatBytes(family.chargedBytes)}`,
			)
			.join(" · ");
		if (compilerFamilies !== "") {
			lines.push(`  Exact allocation families ${compilerFamilies}`);
		}
		if (manifest.compiler.overflow !== null) {
			lines.push(
				`  Exact allocation breakdown overflowed ${formatCount(
					manifest.compiler.overflow.count,
				)} allocations; global exact totals remain complete`,
			);
		}
		const exactLimit = Math.min(5, limit);
		const runtimeRankings = [
			{ event: "runtimeDispatch", label: "native dispatch" },
			{ event: "runtimeString", label: "string runtime" },
			{ event: "runtimeRegExp", label: "RegExp runtime" },
			{ event: "runtimeHost", label: "host runtime" },
		] as const;
		for (const ranking of runtimeRankings) {
			const runtimeFindings = formatExactRuntimeFindings(
				result.findings,
				ranking.event,
				ranking.label,
				ranking.event === "runtimeDispatch" ? exactLimit : Math.min(3, exactLimit),
			);
			if (runtimeFindings.length === 0) continue;
			lines.push(`  Exact ${ranking.label} sites`);
			lines.push(...runtimeFindings);
		}
		const fallbackFindings = formatExactFallbackFindings(result.findings, exactLimit);
		if (fallbackFindings.length > 0) {
			lines.push("  Exact fallback pressure");
			lines.push(...fallbackFindings);
		}
		const allocationFindings = formatExactAllocationFindings(result.findings, exactLimit);
		if (allocationFindings.length > 0) {
			lines.push("  Exact allocation sites");
			lines.push(...allocationFindings);
		}
	}
	lines.push("  Hot source sites");
	lines.push(...formatProfileFindings(result.findings, limit));
	return lines;
}
