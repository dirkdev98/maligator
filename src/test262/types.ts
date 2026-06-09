export interface Test262Frontmatter {
	description?: string;
	info?: string;
	features?: Array<string>;
	flags?: Array<string>;
	includes?: Array<string>;
	negative?: {
		phase: "parse" | "early" | "resolution" | "runtime";
		type: string;
	};
	esid?: string;
	author?: string;
}

export type Test262Result =
	| "UNKNOWN"
	| "SKIPPED"
	| "UNSUPPORTED"
	| "COMPILE_FAILED"
	| "PASSED"
	| "FAILED"
	| "CRASHED"
	| "TIMEOUT";

export interface Test262File {
	path: string;
	frontmatter: Test262Frontmatter;
	content: string;
	result: Test262Result;
}

export interface Test262Cache {
	sha: string;
	files: Array<Test262File>;
}

/**
 * The committed results file. Result categories are folded to keep diffs
 * readable: everything that is not PASSED or SKIPPED counts as FAILED.
 */
export interface Test262Output {
	sha: string;
	summary: Record<string, number>;

	/**
	 * Code-size totals over all compiled tests, tracked across commits so the
	 * impact of optimizations (and added syntax coverage) is visible in the diff.
	 */
	code?: {
		compiledFiles: number;
		functionCount: number;
		instructionCount: number;
	};

	results: Record<string, "PASSED" | "SKIPPED" | "FAILED">;
}
