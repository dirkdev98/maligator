import { hash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "./atomic-file.ts";
import { lexicalCodeMask } from "./compiler/frontend/compact-type-strip.ts";

interface SourceConeEntry {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	dev: number;
	digest: string;
	imports: Array<string>;
}

interface SourceConeManifest {
	schema: 3;
	entries: Record<string, SourceConeEntry>;
}

interface SourceToken {
	kind: "word" | "string" | "punctuation";
	text: string;
}

function sourceTokens(source: string, filePath: string): Array<SourceToken> {
	const code = lexicalCodeMask(source, filePath);
	const tokens: Array<SourceToken> = [];
	for (let i = 0; i < source.length;) {
		if (!code[i] || /\s/.test(source[i]!)) {
			i++;
			continue;
		}
		const start = i;
		const char = source[i]!;
		if (char === '"' || char === "'") {
			i++;
			while (i < source.length) {
				if (source[i] === "\\") {
					i += 2;
					continue;
				}
				if (source[i++] === char) break;
			}
			tokens.push({ kind: "string", text: source.slice(start + 1, i - 1) });
		} else if (/[A-Za-z_$]/.test(char)) {
			i++;
			while (i < source.length && code[i] && /[A-Za-z0-9_$]/.test(source[i]!)) i++;
			tokens.push({ kind: "word", text: source.slice(start, i) });
		} else {
			i++;
			tokens.push({ kind: "punctuation", text: char });
		}
	}
	return tokens;
}

function afterBraces(tokens: Array<SourceToken>, start: number): number {
	let depth = 0;
	for (let i = start; i < tokens.length; i++) {
		if (tokens[i]!.text === "{") depth++;
		else if (tokens[i]!.text === "}" && --depth === 0) return i + 1;
	}
	return tokens.length;
}

function relativeSourceImports(source: string, filePath: string): Array<string> {
	const tokens = sourceTokens(source, filePath);
	const specifiers = new Set<string>();
	const add = (token: SourceToken | undefined) => {
		if (token?.kind === "string" && /^\.\.?\//.test(token.text))
			specifiers.add(token.text);
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.kind !== "word" || (token.text !== "import" && token.text !== "export"))
			continue;
		if (tokens[i - 1]?.text === ".") continue;
		let next = i + 1;
		if (token.text === "import" && tokens[next]?.text === "(") {
			if (tokens[next + 2]?.text === ")" || tokens[next + 2]?.text === ",")
				add(tokens[next + 1]);
			continue;
		}
		if (token.text === "import" && tokens[next]?.kind === "string") {
			add(tokens[next]);
			continue;
		}
		// Type stripping erases type-only declarations, so they never reach the module graph.
		if (
			tokens[next]?.text === "type" &&
			tokens[next + 1]?.text !== "from" &&
			tokens[next + 1]?.text !== ","
		)
			continue;
		if (token.text === "export") {
			if (tokens[next]?.text === "{") next = afterBraces(tokens, next);
			else if (tokens[next]?.text === "*") {
				next++;
				if (tokens[next]?.text === "as") next += 2;
			} else continue;
		} else {
			if (tokens[next]?.kind === "word") {
				next++;
				if (tokens[next]?.text === ",") next++;
			}
			if (tokens[next]?.text === "{") next = afterBraces(tokens, next);
			else if (tokens[next]?.text === "*") next += 3;
		}
		if (tokens[next]?.text === "from") add(tokens[next + 1]);
	}
	return [...specifiers].sort();
}

function readSourceConeManifest(file: string): SourceConeManifest | undefined {
	try {
		const manifest = JSON.parse(readFileSync(file, "utf8")) as SourceConeManifest;
		return manifest.schema === 3 ? manifest : undefined;
	} catch {
		return undefined;
	}
}

function sourceEntry(
	sourceRoot: string,
	relativePath: string,
	previous: SourceConeEntry | undefined,
): SourceConeEntry {
	const file = path.join(sourceRoot, relativePath);
	const stats = statSync(file);
	if (
		previous !== undefined &&
		previous.size === stats.size &&
		previous.mtimeMs === stats.mtimeMs &&
		previous.ctimeMs === stats.ctimeMs &&
		previous.ino === stats.ino &&
		previous.dev === stats.dev
	) {
		return previous;
	}
	const source = readFileSync(file, "utf8");
	return {
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		ino: stats.ino,
		dev: stats.dev,
		digest: hash("sha256", source, "hex"),
		imports: relativeSourceImports(source, relativePath),
	};
}

function resolvedImport(sourceRoot: string, importer: string, specifier: string): string {
	const imported = path.resolve(sourceRoot, path.dirname(importer), specifier);
	const relative = path.relative(sourceRoot, imported);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(`compiler source import escapes the source root: ${specifier}`);
	}
	return relative;
}

/**
 * Content digests of the files reachable from `roots` through relative imports, sorted
 * by root-relative path. Type-only edges count, so the cone covers the module graph any
 * type stripper builds from the same roots. The manifest memoizes each file's digest
 * and imports under its stat identity.
 */
export function relativeImportCone(
	sourceRoot: string,
	roots: ReadonlyArray<string>,
	manifestPath: string,
): Array<[string, string]> {
	const previous = readSourceConeManifest(manifestPath);
	const entries: Record<string, SourceConeEntry> = {};
	const pending = [...roots];
	let reused = 0;
	while (pending.length > 0) {
		const relativePath = pending.pop()!;
		if (entries[relativePath] !== undefined) continue;
		const cached = previous?.entries[relativePath];
		const entry = sourceEntry(sourceRoot, relativePath, cached);
		if (entry === cached) reused++;
		entries[relativePath] = entry;
		for (const specifier of entry.imports) {
			pending.push(resolvedImport(sourceRoot, relativePath, specifier));
		}
	}
	const files = Object.keys(entries).length;
	if (reused !== files || Object.keys(previous?.entries ?? {}).length !== files) {
		try {
			writeFileAtomically(manifestPath, `${JSON.stringify({ schema: 3, entries })}\n`);
		} catch {
			// A read-only cache must not make compilation unavailable.
		}
	}
	return Object.entries(entries)
		.map(([file, entry]): [string, string] => [file, entry.digest])
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
