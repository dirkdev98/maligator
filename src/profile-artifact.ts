import { hash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { VmDefinition } from "./lower-vm.ts";
import type { CompilerRemark, ProfileSite } from "./profile-metadata.ts";

const CAPTURE_HEADER_BYTES = 40;
const CAPTURE_RECORD_BYTES = 40;
const CAPTURE_FRAME_V1_BYTES = 8;
const CAPTURE_FRAME_V2_BYTES = 12;
const COMPILER_HEADER_BYTES = 24;
const COMPILER_EVENT_NAMES = [
	"executions",
	"fastPaths",
	"fallbacks",
	"allocationCount",
	"allocationBytes",
	"boxing",
	"safepoints",
	"gc",
] as const;

type CompilerEventName = (typeof COMPILER_EVENT_NAMES)[number];
type CompilerEvents = Record<CompilerEventName, number>;

export interface PreparedProfile {
	schema: 1 | 2;
	mode: "sampling" | "compiler";
	buildId: string;
	entrypoint: string;
	functions: Array<{ name: string; file: string }>;
	sites: Array<ProfileSite>;
	remarks: Array<CompilerRemark>;
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
	delayNs: number;
	frames: Array<RawFrame>;
}

interface RawCapture {
	intervalUs: number;
	droppedRecords: number;
	droppedFrames: number;
	records: Array<RawRecord>;
}

interface CompilerCapture {
	trackedSiteCount: number;
	totalSiteCount: number;
	unattributed: CompilerEvents;
	bySite: Array<CompilerEvents>;
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
	remarks: Array<CompilerRemark["code"]>;
	decisions: Array<CompilerRemark>;
	compiler?: CompilerEvents;
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
	"call.direct-compiled": "call targets compiled code behind a callee guard",
	"call.direct-native": "call uses the native-number compiled ABI",
	"call.inline-cache": "dynamic call retains its runtime target cache",
	"call.projected": "call result is projected behind a semantic fallback",
	"property.dynamic-inline-cache": "dynamic key retains its runtime shape cache",
	"property.array-inline-cache": "array access uses a guarded indexed cache",
	"property.finite-key": "property access uses a guarded finite-key projection",
	"property.projected": "property access is projected behind a semantic fallback",
	"property.static-inline-cache": "static key retains its runtime shape cache",
	"property.watched": "property access is specialized behind an invalidatable epoch",
};

function functionName(definition: VmDefinition, index: number): string {
	const fn = definition.functions[index];
	if (fn === undefined) return "<unknown>";
	return (
		String.fromCodePoint(...(definition.stringConstants[fn.nameStringIndex] ?? [])) ||
		"<anonymous>"
	);
}

/** Freeze the compiler-side half of a capture next to the exact linked binary. */
export function prepareProfile(
	binaryPath: string,
	definition: VmDefinition,
	mode: PreparedProfile["mode"] = "sampling",
): PreparedProfile {
	const prepared: PreparedProfile = {
		schema: 2,
		mode,
		buildId: hash("sha256", readFileSync(binaryPath), "hex"),
		entrypoint: definition.entrypointPath,
		functions: definition.functions.map((fn, index) => ({
			name: functionName(definition, index),
			file: definition.files[fn.fileIndex] ?? "<unknown>",
		})),
		sites: definition.profileSites ?? [],
		remarks: definition.profileRemarks ?? [],
	};
	atomicJson(`${binaryPath}.profile.json`, prepared);
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
): { directory: string; capturePath: string } {
	const override = process.env.MALIGATOR_PROFILE_DIRECTORY;
	const directory = path.resolve(
		override === undefined
			? defaultProfileDirectory(command, prepared, cwd)
			: command.startsWith("dev-")
				? path.join(override, command)
				: override,
	);
	mkdirSync(directory, { recursive: true });
	atomicJson(path.join(directory, "metadata.json"), prepared);
	return { directory, capturePath: path.join(directory, "capture.bin") };
}

function checkedNumber(value: bigint, label: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number))
		throw new Error(`${label} exceeds JavaScript safe range`);
	return number;
}

export function parseProfileCapture(bytes: Uint8Array): RawCapture {
	if (bytes.byteLength < CAPTURE_HEADER_BYTES)
		throw new Error("profile capture is truncated");
	const magic = Buffer.from(bytes.subarray(0, 8)).toString();
	if (magic !== "MALPROF1" && magic !== "MALPROF2") {
		throw new Error("profile capture has an unknown magic value");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const schema = view.getUint32(8, true);
	if ((magic === "MALPROF1" && schema !== 1) || (magic === "MALPROF2" && schema !== 2))
		throw new Error("profile capture schema is unsupported");
	const recordCount = view.getUint32(12, true);
	const frameCount = view.getUint32(16, true);
	const frameBytes = schema === 1 ? CAPTURE_FRAME_V1_BYTES : CAPTURE_FRAME_V2_BYTES;
	const expected =
		CAPTURE_HEADER_BYTES + recordCount * CAPTURE_RECORD_BYTES + frameCount * frameBytes;
	if (bytes.byteLength !== expected)
		throw new Error("profile capture length does not match its header");
	const frames: Array<RawFrame> = [];
	const frameBase = CAPTURE_HEADER_BYTES + recordCount * CAPTURE_RECORD_BYTES;
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
		const offset = CAPTURE_HEADER_BYTES + index * CAPTURE_RECORD_BYTES;
		const frameOffset = view.getUint32(offset + 32, true);
		const recordFrameCount = view.getUint32(offset + 36, true);
		if (frameOffset + recordFrameCount > frames.length) {
			throw new Error("profile capture record references frames outside the capture");
		}
		records.push({
			kind: view.getUint8(offset),
			timestampNs: checkedNumber(view.getBigUint64(offset + 8, true), "timestamp"),
			value: checkedNumber(view.getBigUint64(offset + 16, true), "record value"),
			delayNs: checkedNumber(view.getBigUint64(offset + 24, true), "sample delay"),
			frames: frames.slice(frameOffset, frameOffset + recordFrameCount),
		});
	}
	return {
		intervalUs: view.getUint32(28, true),
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
		allocationBytes: 0,
		boxing: 0,
		safepoints: 0,
		gc: 0,
	};
}

function compilerEventsAt(view: DataView, offset: number): CompilerEvents {
	const events = emptyCompilerEvents();
	for (const [index, name] of COMPILER_EVENT_NAMES.entries()) {
		events[name] = checkedNumber(
			view.getBigUint64(offset + index * 8, true),
			`compiler event ${name}`,
		);
	}
	return events;
}

export function parseCompilerCapture(bytes: Uint8Array): CompilerCapture {
	if (bytes.byteLength < COMPILER_HEADER_BYTES)
		throw new Error("compiler profile is truncated");
	if (Buffer.from(bytes.subarray(0, 8)).toString() !== "MALSITE1")
		throw new Error("compiler profile has an unknown magic value");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(8, true) !== 1)
		throw new Error("compiler profile schema is unsupported");
	const trackedSiteCount = view.getUint32(12, true);
	const totalSiteCount = view.getUint32(16, true);
	const eventCount = view.getUint32(20, true);
	if (eventCount !== COMPILER_EVENT_NAMES.length)
		throw new Error("compiler profile event schema is unsupported");
	const eventBytes = eventCount * 8;
	const expected = COMPILER_HEADER_BYTES + eventBytes + trackedSiteCount * eventBytes;
	if (bytes.byteLength !== expected)
		throw new Error("compiler profile length does not match its header");
	const unattributed = compilerEventsAt(view, COMPILER_HEADER_BYTES);
	const bySite = Array.from({ length: trackedSiteCount }, (_, siteId) =>
		compilerEventsAt(view, COMPILER_HEADER_BYTES + eventBytes * (siteId + 1)),
	);
	return { trackedSiteCount, totalSiteCount, unattributed, bySite };
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
	}
	const bySite = new Map<number, FindingAggregate>();
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
			value = { siteId: site.id, cpuSamples: 0, allocationSamples: 0, sampledBytes: 0 };
			bySite.set(site.id, value);
		}
		if (record.kind === 1) {
			value.cpuSamples++;
		} else if (record.kind === 2) {
			value.allocationSamples++;
			value.sampledBytes += record.value;
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
			});
		}
	}
	return [...bySite.values()]
		.map((value) => {
			const site = prepared.sites[value.siteId]!;
			const cpuConfidence = evidenceConfidence(value.cpuSamples, quality);
			const allocationConfidence = evidenceConfidence(value.allocationSamples, quality);
			const decisions = prepared.remarks
				.filter((remark) => remark.siteId === site.id)
				.sort((left, right) => {
					const rank: Record<CompilerRemark["outcome"], number> = {
						applied: 0,
						elided: 0,
						guarded: 1,
						retained: 2,
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
				...value,
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
				cpuConfidence,
				allocationConfidence,
			};
		})
		.sort(
			(left, right) =>
				right.cpuSamples - left.cpuSamples ||
				(right.compiler?.executions ?? 0) - (left.compiler?.executions ?? 0) ||
				right.sampledBytes - left.sampledBytes,
		);
}

function atomicJson(file: string, value: unknown): void {
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`);
	renameSync(temporary, file);
}

function profileQuality(capture: RawCapture): ProfileQuality {
	const cpuRecords = capture.records.filter((record) => record.kind === 1);
	const allocationRecords = capture.records.filter((record) => record.kind === 2);
	const delays = cpuRecords.map((record) => record.delayNs / 1e6);
	return capture.droppedRecords > Math.max(1, cpuRecords.length / 100) ||
		percentile(delays, 0.99) > (capture.intervalUs / 1000) * 4
		? "biased"
		: cpuRecords.length < 20 && allocationRecords.length < 20
			? "insufficient"
			: "good";
}

export function finalizeProfileCapture(
	directory: string,
	prepared: PreparedProfile,
	command: string,
): { findings: Array<ProfileFinding>; manifest: object } {
	const capture = parseProfileCapture(readFileSync(path.join(directory, "capture.bin")));
	const compilerPath = path.join(directory, "capture.bin.compiler");
	if (prepared.mode === "compiler" && !existsSync(compilerPath)) {
		throw new Error("compiler profile counter artifact is missing");
	}
	const compiler = existsSync(compilerPath)
		? parseCompilerCapture(readFileSync(compilerPath))
		: undefined;
	const quality = profileQuality(capture);
	const ranked = findings(capture, prepared, quality, compiler);
	const cpuRecords = capture.records.filter((record) => record.kind === 1);
	const allocationRecords = capture.records.filter((record) => record.kind === 2);
	const delays = cpuRecords.map((record) => record.delayNs / 1e6);
	atomicJson(path.join(directory, "cpu.cpuprofile"), cpuProfile(capture, prepared));
	atomicJson(
		path.join(directory, "timeline.json"),
		capture.records
			.filter((record) => record.kind >= 3)
			.map((record) => ({
				name: record.kind === 3 ? "GC" : "GC",
				cat: "maligator.gc",
				ph: record.kind === 3 ? "B" : "E",
				ts: record.timestampNs / 1000,
				pid: 1,
				tid: 1,
				args: { major: record.value === 1 },
			})),
	);
	atomicJson(
		path.join(directory, "allocations.json"),
		ranked.filter((finding) => finding.allocationSamples > 0),
	);
	if (compiler !== undefined) {
		atomicJson(path.join(directory, "compiler.json"), {
			schema: 1,
			trackedSiteCount: compiler.trackedSiteCount,
			totalSiteCount: compiler.totalSiteCount,
			unattributed: compiler.unattributed,
			sites: ranked
				.filter((finding) => finding.compiler !== undefined)
				.map((finding) => ({
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
				})),
		});
	}
	writeFileSync(
		path.join(directory, "remarks.jsonl"),
		prepared.remarks.map((remark) => JSON.stringify(remark)).join("\n") +
			(prepared.remarks.length === 0 ? "" : "\n"),
	);
	atomicJson(path.join(directory, "summary.json"), { schema: 2, findings: ranked });
	const manifest = {
		schema: 2,
		status: "complete",
		command,
		mode: prepared.mode,
		buildId: prepared.buildId,
		entrypoint: prepared.entrypoint,
		intervalUs: capture.intervalUs,
		cpuSamples: cpuRecords.length,
		allocationSamples: allocationRecords.length,
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
		},
		compiler:
			compiler === undefined
				? undefined
				: {
						trackedSiteCount: compiler.trackedSiteCount,
						totalSiteCount: compiler.totalSiteCount,
						unattributed: compiler.unattributed,
					},
		droppedRecords: capture.droppedRecords,
		droppedFrames: capture.droppedFrames,
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
	limit = 5,
): Array<string> {
	if (values.length === 0) return ["  No source-attributed samples were captured."];
	return values.slice(0, limit).map((finding, index) => {
		const primaryDecision = finding.decisions[0];
		const evidence = [
			finding.cpuSamples > 0
				? `${(finding.cpuShare * 100).toFixed(1)}% CPU (${finding.cpuSamples} samples, ${finding.cpuConfidence})`
				: undefined,
			finding.allocationSamples > 0
				? `${finding.allocationSamples} allocation samples (${finding.allocationConfidence})`
				: undefined,
			finding.compiler === undefined
				? undefined
				: `${finding.compiler.executions} exact executions · ${finding.compiler.fastPaths} fast · ${finding.compiler.fallbacks} fallback · ${finding.compiler.allocationBytes} allocated bytes`,
			primaryDecision === undefined
				? undefined
				: `${REMARK_EXPLANATIONS[primaryDecision.code] ?? primaryDecision.code}${
						primaryDecision.reasonCode === undefined
							? ""
							: ` [${primaryDecision.reasonCode}]`
					}`,
		]
			.filter((value) => value !== undefined)
			.join(" · ");
		return `  ${index + 1}. ${finding.file}:${finding.line}:${finding.column + 1} — ${evidence}`;
	});
}
