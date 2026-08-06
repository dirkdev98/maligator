export type TestMode = "normal" | "skip" | "todo" | "only";

export type TestFailureKind =
	| "assertion"
	| "test"
	| "hook"
	| "timeout"
	| "module-load"
	| "syntax"
	| "infrastructure";

export interface TestFailure {
	kind: TestFailureKind;
	message: string;
	name?: string;
	stack?: string;
	matcher?: string;
	expected?: string;
	received?: string;
	diff?: string;
}

export type TestEvent =
	| { type: "run-start"; sequence: number; repeat: number }
	| {
			type: "run-end";
			sequence: number;
			passed: number;
			failed: number;
			skipped: number;
			todo: number;
			durationMs: number;
	  }
	| {
			type: "suite-start" | "suite-end";
			sequence: number;
			name: string;
			file?: string;
	  }
	| { type: "test-start"; sequence: number; name: string; file?: string }
	| {
			type: "test-pass";
			sequence: number;
			name: string;
			durationMs: number;
			file?: string;
	  }
	| {
			type: "test-fail";
			sequence: number;
			name: string;
			durationMs: number;
			failures: Array<TestFailure>;
			file?: string;
	  }
	| {
			type: "test-skip" | "test-todo";
			sequence: number;
			name: string;
			file?: string;
	  }
	| {
			type: "hook-fail";
			sequence: number;
			name: string;
			hook: "beforeAll" | "afterAll" | "beforeEach" | "afterEach";
			failure: TestFailure;
			file?: string;
	  }
	| {
			type: "diagnostic";
			sequence: number;
			level: "warning" | "info";
			message: string;
	  };

export interface TestRunOptions {
	files?: Array<string>;
	nameFilter?: string;
	shuffleSeed?: number;
	repeat: number;
	bail: boolean;
	timeoutMs: number;
}

export interface TestRunResult {
	events: Array<TestEvent>;
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

export interface TestFileResult extends TestRunResult {
	file: string;
	cache: "hit" | "miss";
	frontendMs: number;
	executionMs: number;
}
