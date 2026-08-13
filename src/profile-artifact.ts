import { hash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { VmDefinition } from "./lower-vm.ts";
import type { CompilerRemark, ProfileSite } from "./profile-metadata.ts";

const CAPTURE_HEADER_BYTES = 40;
const CAPTURE_RECORD_BYTES = 40;
const CAPTURE_FRAME_BYTES = 8;

export interface PreparedProfile {
	schema: 1;
	buildId: string;
	entrypoint: string;
	functions: Array<{ name: string; file: string }>;
	sites: Array<ProfileSite>;
	remarks: Array<CompilerRemark>;
}

interface RawFrame {
	functionIndex: number;
	positionId: number;
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

export interface ProfileFinding {
	siteId: number;
	logicalId: string;
	file: string;
	line: number;
	column: number;
	cpuSamples: number;
	cpuShare: number;
	allocationSamples: number;
	sampledBytes: number;
	remarks: Array<CompilerRemark["code"]>;
	confidence: "low" | "medium" | "high";
}

const REMARK_EXPLANATIONS: Record<CompilerRemark["code"], string> = {
	"call.generic": "call stayed on generic dispatch",
	"call.guarded": "compiler emitted guarded direct dispatch",
	"object.heap": "object remains heap allocated",
	"object.shaped": "compiler selected shaped-object construction",
	"property.dynamic-load": "dynamic key kept the property load generic",
	"property.dynamic-store": "dynamic key kept the property store generic",
	"property.static-load": "compiler selected a static-key load cache",
	"property.static-store": "compiler selected a static-key store cache",
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
): PreparedProfile {
	const prepared: PreparedProfile = {
		schema: 1,
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
	if (Buffer.from(bytes.subarray(0, 8)).toString() !== "MALPROF1") {
		throw new Error("profile capture has an unknown magic value");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(8, true) !== 1)
		throw new Error("profile capture schema is unsupported");
	const recordCount = view.getUint32(12, true);
	const frameCount = view.getUint32(16, true);
	const expected =
		CAPTURE_HEADER_BYTES +
		recordCount * CAPTURE_RECORD_BYTES +
		frameCount * CAPTURE_FRAME_BYTES;
	if (bytes.byteLength !== expected)
		throw new Error("profile capture length does not match its header");
	const frames: Array<RawFrame> = [];
	const frameBase = CAPTURE_HEADER_BYTES + recordCount * CAPTURE_RECORD_BYTES;
	for (let index = 0; index < frameCount; index++) {
		const offset = frameBase + index * CAPTURE_FRAME_BYTES;
		frames.push({
			functionIndex: view.getInt32(offset, true),
			positionId: view.getInt32(offset + 4, true),
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

function siteIndex(prepared: PreparedProfile): Map<string, ProfileSite> {
	const result = new Map<string, ProfileSite>();
	for (const site of prepared.sites) {
		const key = `${site.functionIndex}:${site.positionId}`;
		const existing = result.get(key);
		if (
			existing === undefined ||
			(existing.operation !== "execute" && site.operation === "execute")
		) {
			result.set(key, site);
		}
	}
	return result;
}

function percentile(values: Array<number>, fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function cpuProfile(capture: RawCapture, prepared: PreparedProfile): object {
	const sites = siteIndex(prepared);
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
			stackKey += `/${frame.functionIndex}:${frame.positionId}`;
			let id = nodeByStack.get(stackKey);
			if (id === undefined) {
				id = nodes.length + 1;
				const site = sites.get(`${frame.functionIndex}:${frame.positionId}`);
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

function findings(capture: RawCapture, prepared: PreparedProfile): Array<ProfileFinding> {
	const sites = siteIndex(prepared);
	interface FindingAggregate {
		siteId: number;
		cpuSamples: number;
		allocationSamples: number;
		sampledBytes: number;
	}
	const bySite = new Map<number, FindingAggregate>();
	let cpuTotal = 0;
	for (const record of capture.records) {
		const leaf = record.frames.at(-1);
		if (leaf === undefined) continue;
		const site = sites.get(`${leaf.functionIndex}:${leaf.positionId}`);
		if (site === undefined) continue;
		let value = bySite.get(site.id);
		if (value === undefined) {
			value = { siteId: site.id, cpuSamples: 0, allocationSamples: 0, sampledBytes: 0 };
			bySite.set(site.id, value);
		}
		if (record.kind === 1) {
			value.cpuSamples++;
			cpuTotal++;
		} else if (record.kind === 2) {
			value.allocationSamples++;
			value.sampledBytes += record.value;
		}
	}
	return [...bySite.values()]
		.map((value) => {
			const site = prepared.sites[value.siteId]!;
			const evidence = value.cpuSamples + value.allocationSamples;
			const confidence: ProfileFinding["confidence"] =
				evidence >= 100 ? "high" : evidence >= 20 ? "medium" : "low";
			return {
				...value,
				logicalId: site.logicalId,
				file: site.file,
				line: site.line,
				column: site.column,
				cpuShare: cpuTotal === 0 ? 0 : value.cpuSamples / cpuTotal,
				remarks: prepared.remarks
					.filter((remark) => {
						const remarkedSite = prepared.sites[remark.siteId];
						return (
							remarkedSite?.functionIndex === site.functionIndex &&
							remarkedSite.positionId === site.positionId
						);
					})
					.sort((left, right) =>
						left.outcome === right.outcome ? 0 : left.outcome === "retained" ? -1 : 1,
					)
					.map((remark) => remark.code),
				confidence,
			};
		})
		.sort(
			(left, right) =>
				right.cpuSamples - left.cpuSamples || right.sampledBytes - left.sampledBytes,
		);
}

function atomicJson(file: string, value: unknown): void {
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`);
	renameSync(temporary, file);
}

export function finalizeProfileCapture(
	directory: string,
	prepared: PreparedProfile,
	command: string,
): { findings: Array<ProfileFinding>; manifest: object } {
	const capture = parseProfileCapture(readFileSync(path.join(directory, "capture.bin")));
	const ranked = findings(capture, prepared);
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
	writeFileSync(
		path.join(directory, "remarks.jsonl"),
		prepared.remarks.map((remark) => JSON.stringify(remark)).join("\n") +
			(prepared.remarks.length === 0 ? "" : "\n"),
	);
	atomicJson(path.join(directory, "summary.json"), { schema: 1, findings: ranked });
	const manifest = {
		schema: 1,
		status: "complete",
		command,
		buildId: prepared.buildId,
		entrypoint: prepared.entrypoint,
		intervalUs: capture.intervalUs,
		cpuSamples: cpuRecords.length,
		allocationSamples: allocationRecords.length,
		droppedRecords: capture.droppedRecords,
		droppedFrames: capture.droppedFrames,
		sampleDelayMs: {
			median: percentile(delays, 0.5),
			p99: percentile(delays, 0.99),
		},
		quality:
			capture.droppedRecords > Math.max(1, cpuRecords.length / 100) ||
			percentile(delays, 0.99) > (capture.intervalUs / 1000) * 4
				? "biased"
				: cpuRecords.length < 20 && allocationRecords.length < 20
					? "insufficient"
					: "good",
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
		const evidence = [
			finding.cpuSamples > 0 ? `${(finding.cpuShare * 100).toFixed(1)}% CPU` : undefined,
			finding.allocationSamples > 0
				? `${finding.allocationSamples} allocation samples`
				: undefined,
			finding.remarks[0] === undefined
				? undefined
				: REMARK_EXPLANATIONS[finding.remarks[0]],
			finding.confidence === "low" ? "low evidence" : undefined,
		]
			.filter((value) => value !== undefined)
			.join(" · ");
		return `  ${index + 1}. ${finding.file}:${finding.line}:${finding.column + 1} — ${evidence}`;
	});
}
