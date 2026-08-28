import { referencesArguments } from "../core/semantic-lowering.ts";
import { decodeDirectEvalContext } from "../frontend/direct-eval-context.ts";
import {
	analyzeSourceAndRunSemanticAnalysis,
	parseEvalSource,
} from "../frontend/semantic-analysis.ts";
import type { SemanticProgram } from "../frontend/semantic-analysis.ts";
import { serializeRuntimeImage } from "../target/program-image-codec.ts";
import { compileSemanticProgramToRuntimeImage } from "./compile-runtime-core.ts";

/** VarDeclaredNames of the eval script, represented by its hoisted Program bindings. */
function varDeclaredNames(semantic: SemanticProgram): Set<string> {
	const programScope = semantic.files[0]?.scopes[0];
	return new Set(
		programScope?.bindings
			.filter(
				(binding) =>
					binding.kind === "var" && !binding.undeclared && binding.implicit === undefined,
			)
			.map((binding) => binding.name) ?? [],
	);
}

function hasOnlyEmptyStatements(
	statements: SemanticProgram["files"][number]["ast"]["body"],
): boolean {
	for (const statement of statements) {
		if (statement.type === "EmptyStatement") continue;
		if (statement.type === "BlockStatement" && hasOnlyEmptyStatements(statement.body)) {
			continue;
		}
		return false;
	}
	return true;
}

function isWhitespaceOrLineTerminator(code: number): boolean {
	return (
		code === 0x0009 ||
		code === 0x000b ||
		code === 0x000c ||
		code === 0x0020 ||
		code === 0x00a0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff ||
		code === 0x000a ||
		code === 0x000d ||
		code === 0x2028 ||
		code === 0x2029
	);
}

// A true result is a complete parse of this tiny grammar; false delegates every
// unsupported or malformed source to Meriyah for the authoritative verdict.
function isLexicallyEmptyScript(source: string): boolean {
	let blockDepth = 0;
	for (let index = 0; index < source.length; index++) {
		const code = source.charCodeAt(index);
		if (isWhitespaceOrLineTerminator(code) || code === 0x003b) continue;
		if (code === 0x007b) {
			blockDepth++;
			continue;
		}
		if (code === 0x007d) {
			if (blockDepth === 0) return false;
			blockDepth--;
			continue;
		}
		if (code !== 0x002f || index + 1 >= source.length) return false;
		const next = source.charCodeAt(index + 1);
		if (next === 0x002f) {
			index += 2;
			while (index < source.length) {
				const commentCode = source.charCodeAt(index);
				if (
					commentCode === 0x000a ||
					commentCode === 0x000d ||
					commentCode === 0x2028 ||
					commentCode === 0x2029
				) {
					index--;
					break;
				}
				index++;
			}
			continue;
		}
		if (next !== 0x002a) return false;
		index += 2;
		let closed = false;
		while (index + 1 < source.length) {
			if (
				source.charCodeAt(index) === 0x002a &&
				source.charCodeAt(index + 1) === 0x002f
			) {
				index++;
				closed = true;
				break;
			}
			index++;
		}
		if (!closed) return false;
	}
	return blockDepth === 0;
}

export interface CompileSourceOptions {
	virtualPath?: string;
	debugInfo?: boolean;
	completionValue?: boolean;
	direct?: boolean;
	/** Direct eval inherits strictness from its containing caller. */
	callerStrict?: boolean;
	/** Parameter-environment conflicts are carried by directEvalContext. */
	inParamExpr?: boolean;
	/** Class field initializers do not provide an arguments binding. */
	inFieldInitializer?: boolean;
	/** Encoded inherited method/private syntax and identity shape for direct eval. */
	directEvalContext?: string;
}

export function prepareSourceForCompilation(
	source: string,
	options: CompileSourceOptions = {},
) {
	const directEvalContext = decodeDirectEvalContext(options.directEvalContext);
	const callerStrict = options.callerStrict ?? false;
	const lexicallyEmpty = isLexicallyEmptyScript(source);
	const parsed = lexicallyEmpty
		? {
				type: "script" as const,
				strict: callerStrict,
				ast: {
					type: "Program" as const,
					sourceType: "script" as const,
					body: [],
					loc: {
						start: { line: 1, column: 0 },
						end: { line: 1, column: 0 },
					},
				},
			}
		: parseEvalSource(source, callerStrict, directEvalContext);
	const semanticallyEmpty = hasOnlyEmptyStatements(parsed.ast.body);
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		semanticallyEmpty ? "" : source,
		options.virtualPath ?? "eval",
		semanticallyEmpty
			? {
					...parsed,
					ast: {
						...parsed.ast,
						body: [],
						loc: {
							start: { line: 1, column: 0 },
							end: { line: 1, column: 0 },
						},
					},
				}
			: parsed,
		{
			eval: {
				callerStrict: options.callerStrict ?? false,
				direct: options.direct ?? false,
				directEvalContext,
			},
		},
	);
	if (options.direct && !semantic.files[0]?.strict) {
		const conflictNames = new Set(directEvalContext.varConflictNames);
		const conflict = [...varDeclaredNames(semantic)].find((name) =>
			conflictNames.has(name),
		);
		if (conflict !== undefined) {
			throw new SyntaxError(`Eval var declaration conflicts with '${conflict}'`);
		}
	}
	if (options.inFieldInitializer && referencesArguments(semantic.files[0]?.ast.body)) {
		throw new SyntaxError("'arguments' is not allowed in a class field initializer");
	}
	return { semantic, directEvalContext, semanticallyEmpty };
}

export function compilePreparedSourceToBuffer(
	prepared: ReturnType<typeof prepareSourceForCompilation>,
	options: CompileSourceOptions = {},
): Uint8Array {
	const runtime = compileSemanticProgramToRuntimeImage(prepared.semantic, {
		semanticLowering: {
			evalCompletion: options.completionValue,
			evalDirect: options.direct,
			directEvalContext: prepared.directEvalContext,
		},
	});
	return serializeRuntimeImage(runtime, { debugInfo: options.debugInfo });
}

/**
 * Compile a single JavaScript script source into the binary runtime-image wire
 * format (program-image-codec.ts) — the `mal_runtime_image_load` / `mal_vm_splice_runtime_image`
 * input. This is the trimmed compiler entry that runtime `eval` runs: the script
 * front end (no module graph / bundler / native-C backend / disk build), then
 * lower + serialize. The same function is what gets self-hosted and exposed to
 * the running VM as `__compile` (eval Phase 3); on Node it is also the
 * programmatic equivalent of `index.ts --serialize` for a source string.
 *
 * Script mode (indirect eval / Function body): no ESM import/export. Strict
 * mode matches the implied-strict pipeline.
 */
export function compileSourceToBuffer(
	source: string,
	options: CompileSourceOptions = {},
): Uint8Array {
	return compilePreparedSourceToBuffer(
		prepareSourceForCompilation(source, options),
		options,
	);
}
