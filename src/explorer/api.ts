import { compileExplorerCore, compileMode } from "./compiler.ts";
import { EXPLORER_LIMITS, EXPLORER_SCHEMA, utf8ByteLength } from "./config.ts";

function outputMode(result: ReturnType<typeof compileMode>) {
	return {
		optimizedCore: result.optimizedCore,
		target: result.target,
		malw: result.malw,
		hex: result.hex,
		c: result.c,
		wire: Array.from(result.wire),
		structure: result.structure,
		stats: result.stats,
	};
}

export function compileExplorer(source: string, config: unknown = {}) {
	const compiled = compileExplorerCore(source, config);
	return {
		schema: EXPLORER_SCHEMA,
		config: compiled.config,
		world: compiled.facts.world,
		closure: compiled.facts.closure,
		diagnostics: compiled.diagnostics,
		preCore: compiled.preCore,
		modes: {
			generic: outputMode(compileMode(compiled, "generic")),
			full: outputMode(compileMode(compiled, "full")),
		},
	};
}

export type ExplorerResult = ReturnType<typeof compileExplorer>;
export type ExplorerResponse =
	| { ok: true; result: ExplorerResult }
	| { ok: false; category: "syntax" | "limit" | "compile"; message: string };

/** JSON is the embedding boundary; diagnostics never escape as a pending VM exception. */
export function compileExplorerRequest(input: string): string {
	try {
		const request: unknown = JSON.parse(input);
		if (
			request === null ||
			typeof request !== "object" ||
			!("schema" in request) ||
			request.schema !== EXPLORER_SCHEMA ||
			!("source" in request) ||
			typeof request.source !== "string" ||
			!("config" in request)
		) {
			throw new Error("Invalid explorer request or incompatible compiler version");
		}
		const result = compileExplorer(request.source, request.config);
		const output = JSON.stringify({
			ok: true,
			result,
		} satisfies ExplorerResponse);
		if (utf8ByteLength(output) > EXPLORER_LIMITS.outputBytes)
			throw new RangeError("Output exceeds the 8 MiB limit; use a smaller snippet");
		return output;
	} catch (error) {
		return JSON.stringify({
			ok: false,
			category:
				error instanceof SyntaxError
					? "syntax"
					: error instanceof RangeError
						? "limit"
						: "compile",
			message: error instanceof Error ? error.message : String(error),
		} satisfies ExplorerResponse);
	}
}
