import { hash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { artifactProducer } from "./artifact-store.ts";
import { writeFileAtomically } from "./atomic-file.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { lexicalCodeMask } from "./compiler/frontend/compact-type-strip.ts";
import { hashDirectoryTreesCached } from "./file-tree.ts";

let implementationDigest: string | undefined;

export const COMPILER_PRODUCER_STAGES = [
	"build-frontend",
	"build-fragment",
	"dependency-fragment",
	"test-frontend",
	"test-fragment",
] as const;

export type CompilerProducerStage = (typeof COMPILER_PRODUCER_STAGES)[number];

const PRODUCER_ROOTS: Record<CompilerProducerStage, Array<string>> = {
	// Worker URL construction is outside the import source cone.
	"build-frontend": [
		"build-frontend-cache.ts",
		"node-root-compiler-worker.ts",
		"native-root-compiler-worker.ts",
	],
	"build-fragment": ["build-fragment-cache.ts"],
	"dependency-fragment": ["dependency-fragment-cache.ts"],
	"test-frontend": ["testing/cache.ts"],
	"test-fragment": ["testing/fragment-cache.ts"],
};

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
	schema: 2;
	entries: Record<string, SourceConeEntry>;
}

let installedProducerDigests: Record<CompilerProducerStage, string> | undefined;
const producerImplementationDigests = new Map<CompilerProducerStage, string>();

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
		if (tokens[next]?.text === "type" && tokens[next + 1]?.text !== "from") next++;
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
		return manifest.schema === 2 ? manifest : undefined;
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

export function compilerProducerImplementationDigestForRoot(
	stage: CompilerProducerStage,
	sourceRoot: string,
	cacheDirectory: string,
): string {
	const resolvedSourceRoot = path.resolve(sourceRoot);
	const checkoutKey = hash("sha256", resolvedSourceRoot, "hex").slice(0, 20);
	const manifestPath = path.join(
		cacheDirectory,
		"source-digests",
		`compiler-producer-${stage}-${checkoutKey}.json`,
	);
	const previous = readSourceConeManifest(manifestPath);
	const entries: Record<string, SourceConeEntry> = {};
	const pending = [...PRODUCER_ROOTS[stage]];
	while (pending.length > 0) {
		const relativePath = pending.pop()!;
		if (entries[relativePath] !== undefined) continue;
		const entry = sourceEntry(
			resolvedSourceRoot,
			relativePath,
			previous?.entries[relativePath],
		);
		entries[relativePath] = entry;
		for (const specifier of entry.imports) {
			pending.push(resolvedImport(resolvedSourceRoot, relativePath, specifier));
		}
	}
	try {
		writeFileAtomically(manifestPath, `${JSON.stringify({ schema: 2, entries })}\n`);
	} catch {
		// A read-only cache must not make compilation unavailable.
	}
	const packageJson = JSON.parse(
		readFileSync(path.join(resolvedSourceRoot, "..", "package.json"), "utf8"),
	) as { dependencies?: Record<string, string> };
	return hash(
		"sha256",
		JSON.stringify({
			schema: 2,
			stage,
			entries: Object.entries(entries)
				.map(([file, entry]) => [file, entry.digest])
				.sort(([left], [right]) => (left! < right! ? -1 : left! > right! ? 1 : 0)),
			dependencies: packageJson.dependencies ?? {},
		}),
		"hex",
	);
}

export function compilerProducerDigestsForRoot(
	sourceRoot: string,
	cacheDirectory: string,
): Record<CompilerProducerStage, string> {
	return Object.fromEntries(
		COMPILER_PRODUCER_STAGES.map((stage) => [
			stage,
			compilerProducerImplementationDigestForRoot(stage, sourceRoot, cacheDirectory),
		]),
	) as Record<CompilerProducerStage, string>;
}

export function installCompilerProducerDigests(
	digests: Record<CompilerProducerStage, string>,
): void {
	for (const stage of COMPILER_PRODUCER_STAGES) {
		if (!/^[0-9a-f]{64}$/.test(digests[stage])) {
			throw new Error(`invalid embedded compiler producer digest for ${stage}`);
		}
	}
	installedProducerDigests = digests;
}

export function compilerImplementationDigestForRoot(
	sourceRoot: string,
	cacheDirectory: string,
): string {
	const resolvedSourceRoot = path.resolve(sourceRoot);
	const compilerRoot = path.join(resolvedSourceRoot, "compiler");
	const checkoutKey = hash("sha256", sourceRoot, "hex").slice(0, 20);
	const compilerSources = hashDirectoryTreesCached(
		{
			root: resolvedSourceRoot,
			directories: [compilerRoot],
			include: (entry) =>
				(entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) &&
				!entry.name.endsWith(".d.ts"),
		},
		path.join(cacheDirectory, "source-digests", `compiler-cone-${checkoutKey}.json`),
		"compiler-implementation-cone-v2",
	);
	const rootSources = [
		"build-config-error.ts",
		"build-config-values.ts",
		"platform/catalog.ts",
		"platform/execution.ts",
		"utils.ts",
	].flatMap((relativePath) => [
		relativePath,
		"\0",
		hash("sha256", readFileSync(path.join(resolvedSourceRoot, relativePath)), "hex"),
		"\0",
	]);
	const packageJson = JSON.parse(
		readFileSync(path.join(resolvedSourceRoot, "..", "package.json"), "utf8"),
	) as { dependencies?: { meriyah?: unknown } };
	const meriyahVersion = packageJson.dependencies?.meriyah;
	if (typeof meriyahVersion !== "string") {
		throw new Error("compiler cache identity requires a pinned Meriyah dependency");
	}
	return hash(
		"sha256",
		[
			"compiler-implementation-v2\0",
			compilerSources.digest,
			"\0",
			...rootSources,
			"meriyah\0",
			meriyahVersion,
		].join(""),
		"hex",
	);
}

/** Path-independent digest of the runtime compiler implementation. */
export function compilerImplementationDigest(): string {
	if (implementationDigest !== undefined) return implementationDigest;
	implementationDigest = compilerImplementationDigestForRoot(
		import.meta.dirname,
		maligatorCacheDirectory(),
	);
	return implementationDigest;
}

export function compilerProducerIdentity(
	stage: CompilerProducerStage,
	protocol: number,
): string {
	let digest =
		installedProducerDigests?.[stage] ?? producerImplementationDigests.get(stage);
	if (digest === undefined) {
		digest = compilerProducerImplementationDigestForRoot(
			stage,
			import.meta.dirname,
			maligatorCacheDirectory(),
		);
		producerImplementationDigests.set(stage, digest);
	}
	return artifactProducer(stage, protocol, digest);
}

/** Configuration facts consumed before native emission. */
export function compilerConfigurationIdentity(config: ResolvedBuildConfig): unknown {
	return {
		moduleResolution: { aliases: config.modules.aliases },
		world: {
			primordialPolicy: config.engine.primordials,
			dynamicCompilation: config.engine.eval,
			realms: config.engine.realms,
			ecmaFeatures: {
				regexp: config.engine.regexp,
				temporal: config.engine.temporal,
				intl: config.engine.intl.enabled,
			},
		},
		hostSurface: config.surface,
	};
}
