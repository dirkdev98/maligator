export * from "maligator:test";

export interface RuntimeRunOptions {
	files?: Array<string>;
	nameFilter?: string;
	shuffleSeed?: number;
	repeat: number;
	bail: boolean;
	timeoutMs: number;
}

export interface RuntimeTestFailure {
	kind: string;
	name?: string;
	message: string;
	stack?: string;
	matcher?: string;
	expected?: string;
	received?: string;
	diff?: string;
}

export type RuntimeTestEvent = {
	type: string;
	sequence: number;
	name?: string;
	file?: string;
	message?: string;
	failures?: Array<RuntimeTestFailure>;
};

export interface RuntimeRunResult {
	events: Array<RuntimeTestEvent>;
	files: Array<{
		file: string;
		passed: number;
		failed: number;
		skipped: number;
		todo: number;
		durationMs: number;
	}>;
	passed: number;
	failed: number;
	skipped: number;
	todo: number;
	durationMs: number;
	focused: boolean;
}

export function __run(options: RuntimeRunOptions): Promise<RuntimeRunResult>;
export function __beginFile(file: string): void;
export function __endFile(): void;
export function __reset(): void;

export function __initializeRunner(): void;
