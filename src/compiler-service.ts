import type { MessagePort, TaskContext } from "maligator:workers";
import type { BuildCommandResult, CompilerInstallation } from "./cli-commands.ts";
import type { BuildCommand, DevCommand, RunCommand } from "./cli.ts";
import type { CompilerProducerStage } from "./compiler-cache-identity.ts";
import type { PreparedTestApplication, TestCompilationInput } from "./testing/prepare.ts";

export interface CompilationPhase {
	label: string;
	state: "started" | "completed" | "failed";
	durationMs?: number;
}

export interface CompilationTaskContext extends TaskContext {
	report?: (phase: CompilationPhase) => void;
}

export type CompilationCommand = BuildCommand | DevCommand | RunCommand;

export interface CompilationOptions {
	compact?: boolean;
	invalidatedPaths?: Array<string>;
	invalidateAll?: boolean;
	signal?: AbortSignal;
	concurrency?: number;
	onPhase?: (phase: CompilationPhase) => void;
}

export interface CompilerRequestContext {
	installation: CompilerInstallation;
	producerDigests: Record<CompilerProducerStage, string>;
	invalidatedPaths: Array<string>;
	invalidateAll: boolean;
	cancellation?: SharedArrayBuffer;
	progress?: MessagePort<CompilationPhase>;
}

export interface CompilationRequest extends CompilerRequestContext {
	command: CompilationCommand;
	compact: boolean;
}

export interface TestCompilationRequest extends CompilerRequestContext {
	input: TestCompilationInput;
}

export interface CompilerService {
	readonly parallelism?: number;
	prepare(
		command: CompilationCommand,
		options?: CompilationOptions,
	): Promise<BuildCommandResult>;
	prepareTests?(
		input: TestCompilationInput,
		options?: CompilationOptions,
	): Promise<PreparedTestApplication>;
	close(): Promise<void>;
}
