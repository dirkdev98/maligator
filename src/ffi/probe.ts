import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { artifactDigest } from "../artifact-store.ts";
import { writeFileAtomically } from "../atomic-file.ts";
import { sanitizerMode, sanitizerTestEnvironment } from "../build-flags.ts";
import type { SanitizerMode } from "../build-flags.ts";
import {
	FrontendCompilationSession,
	frontendDependencyUnchanged,
} from "../frontend-cache.ts";
import type { FrontendDependencyIdentity } from "../frontend-cache.ts";
import type {
	IsolatedTestExecutionOptions,
	TestCommandSummary,
} from "../testing/command.ts";
import { FfiError } from "./ffi-error.ts";
import type { PreparedLibrary } from "./library.ts";

interface ArtifactIdentity {
	readonly path: string;
	readonly digest: string;
}

/** Evidence for one host-side sanitizer run, separate from the accepted declarations. */
export interface FfiProbeReport {
	readonly path: string;
	readonly report: string;
	readonly ok: boolean;
	readonly sanitizer: SanitizerMode;
	readonly timeoutMs: number;
	readonly summary?: TestCommandSummary;
	readonly inputs: ReadonlyArray<FrontendDependencyIdentity>;
	readonly lockfile: {
		readonly path: string;
		readonly before?: FrontendDependencyIdentity;
	};
	readonly executable?: ArtifactIdentity;
	readonly wires: ReadonlyArray<ArtifactIdentity>;
	readonly stdout: string;
	readonly stderr: string;
	readonly execution?: {
		readonly status?: number;
		readonly signal?: NodeJS.Signals;
		readonly timedOut?: true;
		readonly durationMs: number;
	};
	readonly changedInputs: ReadonlyArray<string>;
	readonly error?: string;
}

/** Execute the selected tests and retain evidence before a caller accepts a snapshot. */
export async function runFfiProbe(
	options: {
		readonly path: string;
		readonly projectRoot: string;
		readonly configFile: string;
		readonly lockfile: string;
		readonly timeoutMs: number;
		readonly environment: NodeJS.ProcessEnv;
		readonly libraries: ReadonlyArray<PreparedLibrary>;
	},
	execute: (options: IsolatedTestExecutionOptions) => Promise<TestCommandSummary>,
): Promise<FfiProbeReport> {
	const session = new FrontendCompilationSession();
	const inputs = new Map<string, FrontendDependencyIdentity>();
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	const wires: Array<ArtifactIdentity> = [];
	const environment = sanitizerTestEnvironment(process.platform, options.environment);
	let lockBefore: FrontendDependencyIdentity | undefined;
	let executable: ArtifactIdentity | undefined;
	let execution: FfiProbeReport["execution"];
	let summary: TestCommandSummary | undefined;
	let error: string | undefined;
	const snapshot = (file: string): void => {
		const identity = session.snapshot(file);
		inputs.set(identity.path, identity);
	};
	const changed = (): Array<string> => [
		...[...inputs.values()]
			.filter((input) => !frontendDependencyUnchanged(input))
			.map((input) => input.path),
		...(lockBefore === undefined
			? existsSync(options.lockfile)
				? [options.lockfile]
				: []
			: frontendDependencyUnchanged(lockBefore)
				? []
				: [options.lockfile]),
	];
	const requireUnchanged = (): void => {
		const files = changed();
		if (files.length > 0) throw new FfiError(`probe inputs changed: ${files.join(", ")}`);
	};
	const artifact = (file: string): ArtifactIdentity => ({
		path: file,
		digest: artifactDigest(readFileSync(file)),
	});
	try {
		if (existsSync(options.lockfile)) lockBefore = session.snapshot(options.lockfile);
		snapshot(options.configFile);
		const packageFile = path.join(options.projectRoot, "package.json");
		if (existsSync(packageFile)) snapshot(packageFile);
		if (existsSync(options.path) && statSync(options.path).isFile())
			snapshot(options.path);
		for (const library of options.libraries) {
			snapshot(library.contract.path);
			for (const file of [...library.model.dependencies, ...library.library.sources])
				snapshot(file);
			for (const input of library.library.linkInputs)
				if (input.kind === "archive" || input.kind === "shared") snapshot(input.path);
		}
		summary = await execute({
			environment,
			timeoutMs: options.timeoutMs,
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
			onPrepared: (prepared) => {
				requireUnchanged();
				for (const input of prepared.dependencies) {
					if (!frontendDependencyUnchanged(input))
						throw new FfiError(`probe input changed: ${input.path}`);
					if (!inputs.has(input.path)) inputs.set(input.path, input);
				}
				executable = artifact(prepared.binaryPath);
				wires.push(...prepared.wirePaths.map(artifact));
			},
			onExecution: (outcome, durationMs) => {
				execution = {
					status: outcome.status,
					signal: outcome.signal,
					timedOut: outcome.timedOut,
					durationMs,
				};
			},
		});
		if (summary.exitCode !== 0) error = "probe tests failed";
		else if (summary.passed === 0) error = "the probe must pass at least one test";
		requireUnchanged();
	} catch (failure) {
		error = failure instanceof Error ? failure.message : String(failure);
	}
	const changedInputs = changed();
	const report: FfiProbeReport = {
		path: options.path,
		report: path.join(
			options.projectRoot,
			".cache/ffi-check",
			`${Date.now()}-${randomUUID()}.json`,
		),
		ok:
			error === undefined &&
			summary !== undefined &&
			execution?.status === 0 &&
			execution.timedOut !== true &&
			changedInputs.length === 0,
		sanitizer: sanitizerMode(environment),
		timeoutMs: options.timeoutMs,
		...(summary === undefined ? {} : { summary }),
		inputs: [...inputs.values()].sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		),
		lockfile: {
			path: options.lockfile,
			...(lockBefore === undefined ? {} : { before: lockBefore }),
		},
		...(executable === undefined ? {} : { executable }),
		wires,
		stdout: stdout.join(""),
		stderr: stderr.join(""),
		...(execution === undefined ? {} : { execution }),
		changedInputs,
		...(error === undefined ? {} : { error }),
	};
	writeFileAtomically(report.report, `${JSON.stringify(report, null, "\t")}\n`);
	return report;
}
