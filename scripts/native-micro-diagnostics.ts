import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { NativeBuildPhaseEvent } from "../src/native-build-context.ts";
import type { BuildNativeBinaryResult } from "../src/test-harness.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

function digest(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function json(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function command(
	directory: string,
	label: string,
	tool: string,
	args: Array<string>,
): string {
	const result = spawnSync(tool, args, {
		encoding: "utf8",
		env: cleanTestEnvironment({ LC_ALL: "C" }),
		timeout: 30_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	writeFileSync(
		path.join(directory, `${label}.log`),
		`${JSON.stringify({ tool, args, status: result.status })}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
	);
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`${tool} failed; see ${label}.log`);
	return result.stdout;
}

/** The diagnostic lane is explicitly Linux ELF64, matching its hosted runner. */
export function readElfText(file: string) {
	const binary = readFileSync(file);
	if (!binary.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])))
		throw new Error("native micro diagnostics require little-endian ELF64");
	const integer = (offset: number) => {
		const value = Number(binary.readBigUInt64LE(offset));
		if (!Number.isSafeInteger(value))
			throw new Error("ELF offset exceeds safe integer range");
		return value;
	};
	const table = integer(40);
	const stride = binary.readUInt16LE(58);
	const count = binary.readUInt16LE(60);
	const namesIndex = binary.readUInt16LE(62);
	if (
		stride < 64 ||
		count === 0 ||
		namesIndex >= count ||
		table + stride * count > binary.length
	)
		throw new Error("invalid or extended ELF section table");
	const namesOffset = integer(table + namesIndex * stride + 24);
	for (let index = 0; index < count; index++) {
		const header = table + index * stride;
		const nameStart = namesOffset + binary.readUInt32LE(header);
		const nameEnd = binary.indexOf(0, nameStart);
		if (nameEnd < nameStart || binary.toString("utf8", nameStart, nameEnd) !== ".text")
			continue;
		const address = integer(header + 16);
		const offset = integer(header + 24);
		const size = integer(header + 32);
		if (offset + size > binary.length || size === 0)
			throw new Error("invalid ELF .text range");
		const bytes = binary.subarray(offset, offset + size);
		return { address, offset, size, sha256: digest(bytes), bytes };
	}
	throw new Error("ELF has no .text section");
}

export function copyBeforeNativeStrip(
	directory: string,
	event: NativeBuildPhaseEvent,
): void {
	if (event.phase !== "link" || event.cache !== "miss" || event.path === undefined)
		return;
	mkdirSync(directory, { recursive: true });
	copyFileSync(event.path, path.join(directory, "symbols.elf"));
}

/** Capture final-LTO code without modifying the production build plan or timed file. */
export function collectNativeMicroDiagnostics(
	built: BuildNativeBinaryResult,
	directory: string,
	linkCacheVariant: string,
) {
	mkdirSync(directory, { recursive: true });
	const symbolFile = path.join(directory, "symbols.elf");
	const productionFile = path.join(directory, "production.elf");
	const strip = built.context.toolchain.tools.strip;
	if (
		built.measurements.linkCache !== "miss" ||
		!built.context.plan.lto ||
		!built.context.plan.strip ||
		strip === undefined ||
		strip.args?.[0] === "objcopy"
	)
		throw new Error(
			"diagnostics need a fresh final LTO link with separate production stripping",
		);
	copyFileSync(built.binaryPath, productionFile);
	const strippedCopy = path.join(directory, "verify-strip.elf");
	copyFileSync(symbolFile, strippedCopy);
	try {
		command(directory, "verify-strip", strip.path, [
			...(strip.args ?? []),
			...built.context.toolchain.probes.stripArgs,
			strippedCopy,
		]);
		if (!readFileSync(strippedCopy).equals(readFileSync(productionFile)))
			throw new Error(
				"stripping the symbol companion did not reproduce the exact timed executable",
			);
	} finally {
		rmSync(strippedCopy, { force: true });
	}
	const measuredText = readElfText(productionFile);
	const symbolText = readElfText(symbolFile);
	if (
		measuredText.address !== symbolText.address ||
		!measuredText.bytes.equals(symbolText.bytes)
	)
		throw new Error(
			"symbol companion .text address/bytes differ from the timed executable",
		);
	const toolVersions = {
		objdump: command(directory, "objdump-version", "llvm-objdump-19", ["--version"]),
		nm: command(directory, "nm-version", "llvm-nm-19", ["--version"]),
	};
	const nm = command(directory, "symbols", "llvm-nm-19", [
		"--defined-only",
		"--format=posix",
		"--print-size",
		"--radix=x",
		"--numeric-sort",
		symbolFile,
	]);
	const symbols = nm.split("\n").flatMap((line) => {
		const match = /^(\S+)\s+([tTwW])\s+([\da-fA-F]+)\s+([\da-fA-F]+)\s*$/.exec(line);
		if (match === null) return [];
		const address = Number.parseInt(match[3]!, 16);
		const bytes = Number.parseInt(match[4]!, 16);
		if (
			bytes === 0 ||
			address < measuredText.address ||
			address + bytes > measuredText.address + measuredText.size
		)
			return [];
		return [{ symbol: match[1]!, type: match[2]!, address, bytes }];
	});
	if (symbols.length === 0)
		throw new Error("symbol companion has no sized .text symbols");
	json(path.join(directory, "function-sizes.json"), symbols);
	const functions = built.programImage.runtime.functions.map((fn, functionIndex) => {
		const origin = built.programImage.diagnostics.profileFunctions?.[functionIndex];
		const matches = symbols.filter(
			({ symbol }) =>
				Number(/^mal_(?:compiled|direct)_(\d+)(?:_|\.|$)/.exec(symbol)?.[1]) ===
				functionIndex,
		);
		const definitions = built.measurements.objects.flatMap((object) =>
			(object.definitions ?? [])
				.filter(
					({ symbol }) =>
						Number(/^mal_(?:compiled|direct)_(\d+)(?:_|\.|$)/.exec(symbol)?.[1]) ===
						functionIndex,
				)
				.map((definition) => ({ unit: object.unit, ...definition })),
		);
		for (const symbol of matches) {
			const label = symbol.symbol.replace(/[^\w.-]/g, "_");
			const args = [
				"--disassemble",
				"--section=.text",
				`--start-address=${symbol.address}`,
				`--stop-address=${symbol.address + symbol.bytes}`,
			];
			for (const [kind, binary] of [
				["measured", productionFile],
				["annotated", symbolFile],
			] as const) {
				const assembly = command(directory, `${label}.${kind}`, "llvm-objdump-19", [
					...args,
					binary,
				]);
				writeFileSync(path.join(directory, `${label}.${kind}.asm`), assembly);
			}
		}
		return {
			functionIndex,
			name: (built.programImage.runtime.stringConstants[fn.nameStringIndex] ?? [])
				.map((unit) => String.fromCharCode(unit))
				.join(""),
			file: built.programImage.runtime.files[fn.fileIndex],
			origin:
				origin?.status === "captured"
					? {
							status: origin.status,
							moduleKey: origin.source.moduleKey,
							sourceSha256: digest(origin.source.contents),
							declarationSha256: digest(origin.declaration),
							start: origin.start,
							end: origin.end,
							kind: origin.kind,
						}
					: origin,
			definitions,
			status: matches.length === 0 ? "no-final-symbol" : "attributed",
			symbols: matches.map((symbol) => ({
				...symbol,
				sha256: digest(
					measuredText.bytes.subarray(
						symbol.address - measuredText.address,
						symbol.address - measuredText.address + symbol.bytes,
					),
				),
			})),
		};
	});
	const result = {
		schema: 1,
		status: "complete",
		linkCacheVariant,
		toolVersions,
		productionFile,
		productionSha256: digest(readFileSync(productionFile)),
		symbolFile,
		symbolSha256: digest(readFileSync(symbolFile)),
		stripReproducesProduction: true,
		textMatchesProduction: true,
		text: {
			address: measuredText.address,
			bytes: measuredText.size,
			sha256: measuredText.sha256,
		},
		attribution:
			"Final linked symbol extents; aliases may overlap. Missing symbols can be inlined or eliminated and do not imply zero code cost. Function indices are build-local; join source name/file/origin across builds.",
		functions,
	};
	json(path.join(directory, "diagnostics.json"), result);
	return result;
}

export const MICRO_PERF_EVENTS = [
	"cycles:u",
	"instructions:u",
	"branches:u",
	"branch-misses:u",
	"cache-references:u",
	"cache-misses:u",
];

export function parseMicroPerfCounters(output: string) {
	return MICRO_PERF_EVENTS.map((event) => {
		const row = output
			.split("\n")
			.map((line) => line.split(";"))
			.find((fields) => fields[2]?.trim() === event);
		const rawValue = row?.[0]?.trim();
		const value =
			rawValue !== undefined && /^\d+(?:\.\d+)?$/.test(rawValue)
				? Number(rawValue)
				: Number.NaN;
		const rawRunning = row?.[4]?.trim();
		const runningPercent = rawRunning ? Number(rawRunning) : Number.NaN;
		return {
			event,
			value: Number.isFinite(value) && value >= 0 ? value : null,
			runningPercent: Number.isFinite(runningPercent) ? runningPercent : null,
			raw: row?.join(";"),
		};
	});
}

export function hasValidMicroPerfCounters(
	counters: ReturnType<typeof parseMicroPerfCounters>,
): boolean {
	return (
		counters.length === MICRO_PERF_EVENTS.length &&
		counters.every((counter) => counter.value !== null) &&
		(counters[0]?.value ?? 0) > 0 &&
		(counters[1]?.value ?? 0) > 0
	);
}

export function probeNativeMicroPerf(directory: string) {
	const executable = process.env.NATIVE_MICRO_PERF ?? "perf";
	const output = path.join(directory, "perf-probe.csv");
	const args = [
		"stat",
		"--no-big-num",
		"-x",
		";",
		"-o",
		output,
		"-e",
		MICRO_PERF_EVENTS.join(","),
		"--",
		process.execPath,
		"-e",
		"let n=0;for(let i=0;i<1000000;i++)n+=i;console.log(n)",
	];
	const result = spawnSync(executable, args, {
		encoding: "utf8",
		timeout: 10_000,
		env: cleanTestEnvironment({ LC_ALL: "C" }),
	});
	let counters: ReturnType<typeof parseMicroPerfCounters> = [];
	try {
		counters = parseMicroPerfCounters(readFileSync(output, "utf8"));
	} catch {
		/* Missing perf output is recorded as unavailable. */
	}
	const available = result.status === 0 && hasValidMicroPerfCounters(counters);
	const version = spawnSync(executable, ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
	});
	let perfEventParanoid: string | undefined;
	try {
		perfEventParanoid = readFileSync(
			"/proc/sys/kernel/perf_event_paranoid",
			"utf8",
		).trim();
	} catch {
		/* Non-Linux hosts have no perf policy file. */
	}
	const evidence = {
		version: version.stdout?.trim(),
		perfEventParanoid,
		status: available ? "available" : "unavailable",
		reason: available
			? undefined
			: (result.error?.message ??
				(result.stderr?.trim() ||
					"one or more requested hardware events produced no valid counter")),
		executable,
		args,
		exitCode: result.status,
		error: result.error?.message,
		stdout: result.stdout,
		stderr: result.stderr,
		counters,
		scope:
			"Whole process, including startup and five warmups; separate from kernel elapsedMs.",
	};
	json(path.join(directory, "perf-probe.json"), evidence);
	return evidence;
}
