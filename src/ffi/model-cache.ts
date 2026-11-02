import type { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	artifactActionKey,
	artifactOutput,
	publishArtifactAction,
	readArtifactAction,
} from "../artifact-store.ts";
import { maligatorCacheDirectory } from "../cache-root.ts";
import { compilerProducerIdentity } from "../compiler-cache-identity.ts";
import { writeSourceChunks } from "../generated-source.ts";
import {
	extractCModel,
	extractCModelFromHeaders,
	headerSearchDirectories,
	withCHeaders,
} from "./c-extract.ts";
import type { CExtractionInput } from "./c-extract.ts";
import type { CEnum, CModel, CRecord, CTypedef } from "./c-model.ts";

const STAGE = "ffi-header-model";

/**
 * Variables that change which headers clang reads without changing its arguments:
 * include search paths, and the SDK and deployment target on Apple platforms.
 */
const HEADER_ENVIRONMENT = [
	"CPATH",
	"C_INCLUDE_PATH",
	"OBJC_INCLUDE_PATH",
	"SDKROOT",
	"DEVELOPER_DIR",
	"MACOSX_DEPLOYMENT_TARGET",
] as const;

interface Dependency {
	readonly file: string;
	readonly digest: string;
}

interface CachedModel {
	/** Every file the headers read, with its content digest when the model was extracted. */
	readonly dependencies: ReadonlyArray<Dependency>;
	readonly model: CModel;
}

type CachedRow =
	| ["target", CModel["target"]]
	| ["header", CModel["headers"][number]]
	| ["file", string]
	| ["dependency", Dependency]
	| ["function", CModel["functions"][number]]
	| ["record", CRecord]
	| ["enum", CEnum]
	| ["typedef", CTypedef]
	| ["macro", CModel["macros"][number]]
	| ["untypedMacro", CModel["untypedMacros"][number]];

/** Each row fits independently; the aggregate model never becomes one engine string. */
function* encode(
	model: CModel,
	dependencies: ReadonlyArray<Dependency>,
): Generator<string> {
	for (const [kind, entries] of [
		["target", [model.target]],
		["header", model.headers],
		["file", model.files],
		["dependency", dependencies],
		["function", model.functions],
		["record", model.records.values()],
		["enum", model.enums.values()],
		["typedef", model.typedefs.values()],
		["macro", model.macros],
		["untypedMacro", model.untypedMacros],
	] as const) {
		for (const entry of entries) {
			yield JSON.stringify([kind, entry], (_key, value: unknown) =>
				typeof value === "bigint" ? { $bigint: value.toString() } : value,
			);
			yield "\n";
		}
	}
}

function decode(data: Buffer): CachedModel {
	let target: CModel["target"] | undefined;
	const headers: Array<CModel["headers"][number]> = [];
	const files: Array<string> = [];
	const dependencies: Array<Dependency> = [];
	const functions: Array<CModel["functions"][number]> = [];
	const records = new Map<string, CRecord>();
	const enums = new Map<string, CEnum>();
	const typedefs = new Map<string, CTypedef>();
	const macros: Array<CModel["macros"][number]> = [];
	const untypedMacros: Array<CModel["untypedMacros"][number]> = [];
	for (let start = 0; start < data.length;) {
		let end = data.indexOf(10, start);
		if (end < 0) end = data.length;
		const row = JSON.parse(data.toString("utf8", start, end), (_key, value: unknown) => {
			if (typeof value === "object" && value !== null && "$bigint" in value)
				return BigInt((value as { $bigint: string }).$bigint);
			return value;
		}) as CachedRow;
		start = end + 1;
		switch (row[0]) {
			case "target":
				target = row[1];
				break;
			case "header":
				headers.push(row[1]);
				break;
			case "file":
				files.push(row[1]);
				break;
			case "dependency":
				dependencies.push(row[1]);
				break;
			case "function":
				functions.push(row[1]);
				break;
			case "record":
				records.set(row[1].name, row[1]);
				break;
			case "enum":
				enums.set(row[1].name, row[1]);
				break;
			case "typedef":
				typedefs.set(row[1].name, row[1]);
				break;
			case "macro":
				macros.push(row[1]);
				break;
			case "untypedMacro":
				untypedMacros.push(row[1]);
				break;
		}
	}
	if (target === undefined) throw new Error("cached C model has no target");
	return {
		dependencies,
		model: {
			target,
			headers,
			files,
			dependencies: dependencies.map(({ file }) => file),
			functions,
			records,
			enums,
			typedefs,
			macros,
			untypedMacros,
		},
	};
}

/**
 * Reuse AST and probe analysis after Clang resolves the current include graph.
 * Preprocessing observes new shadow headers and conditional include lookups;
 * file versions also cover documentation that preprocessing drops.
 */
export function loadCModel(input: CExtractionInput): CModel {
	const root = maligatorCacheDirectory();
	const cache = canonicalPath(root);
	if (
		headerSearchDirectories(input).some((directory) => {
			const relative = path.relative(canonicalPath(directory, true), cache);
			return (
				relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
			);
		})
	)
		return extractCModel(input);
	const compiler = statSync(input.compiler.path);
	const producer = compilerProducerIdentity(STAGE, 3);
	const analysis = withCHeaders<{
		model: CModel;
		publication?: { key: string; dependencies: ReadonlyArray<Dependency> };
	}>(input, (headers) => {
		if (!headers.cacheable) return { model: extractCModelFromHeaders(input, headers) };
		const key = artifactActionKey(producer, {
			compiler: {
				path: input.compiler.path,
				version: input.compiler.version,
				args: input.compiler.args ?? [],
				size: compiler.size,
				modified: compiler.mtimeMs,
			},
			headers: input.headers,
			preprocessed: headers.preprocessed.identity,
			values: headers.valueProbe.identity,
			versions: headers.versions,
			compileArguments: input.compileArguments,
			environment: HEADER_ENVIRONMENT.map((name) => [
				name,
				input.environment[name] ?? null,
			]),
		});
		const cached = readArtifactAction(root, STAGE, producer, key);
		if (cached !== undefined) {
			const entry = decode(readFileSync(artifactOutput(cached, "model.jsonl").path));
			if (
				entry.dependencies.every(({ file, digest }) =>
					headers.versions.some(
						(version) => version.file === file && version.digest === digest,
					),
				)
			) {
				return { model: entry.model };
			}
		}
		const model = extractCModelFromHeaders(input, headers);
		const dependencies = headers.versions.map(({ file, digest }) => ({ file, digest }));
		return { model, publication: { key, dependencies } };
	});
	if (analysis.publication !== undefined) {
		const { key, dependencies } = analysis.publication;
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-model-"));
		try {
			const file = path.join(directory, "model.jsonl");
			writeSourceChunks(file, encode(analysis.model, dependencies));
			publishArtifactAction(root, STAGE, producer, key, [{ name: "model.jsonl", file }]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	return analysis.model;
}

function canonicalPath(file: string, allowInaccessible = false): string {
	const suffix: Array<string> = [];
	let current = path.resolve(file);
	for (;;) {
		try {
			return path.join(realpathSync(current), ...suffix);
		} catch (error) {
			if (
				allowInaccessible &&
				["EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")
			)
				return path.resolve(file);
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			suffix.unshift(path.basename(current));
			current = parent;
		}
	}
}
