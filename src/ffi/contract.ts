import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { BuildConfigError } from "../build-config-error.ts";
import { parseModule } from "../compiler/frontend/parser.ts";
import type {
	BuildConfigTypeStripper,
	Leaf,
	ObjectSchema,
} from "../definition-module.ts";
import {
	SchemaViolation,
	evaluateDefinitionModule,
	expect,
	expectKeys,
	expectObject,
	validateDefinition,
} from "../definition-module.ts";
import type {
	MaligatorFfiFind,
	MaligatorFfiFunctionFacts,
	MaligatorFfiGlobalFacts,
	MaligatorFfiLibrary,
	MaligatorFfiTypeFacts,
	MaligatorLibraryContract,
} from "../public-api.d.ts";

/** Library names become module specifiers (`maligator:ffi/<name>`) and C identifiers. */
const LIBRARY_NAME = /^[a-z][a-z0-9_]*$/;

const FIND_KEYS = [
	"pkgConfig",
	"includeDirs",
	"defines",
	"libraryDirs",
	"libraries",
	"frameworks",
	"sources",
] as const;

function nonEmptyStringArray(value: unknown, at: string): void {
	expect(
		Array.isArray(value) &&
			value.every((item) => typeof item === "string" && item.length > 0),
		at,
		"an array of non-empty strings",
	);
}

function validateFind(value: unknown, at: string): void {
	expectObject(value, at);
	expectKeys(value, at, FIND_KEYS);
	if (value.pkgConfig !== undefined) {
		expect(
			typeof value.pkgConfig === "string" && value.pkgConfig.length > 0,
			`${at}.pkgConfig`,
			"a non-empty string",
		);
	}
	for (const key of [
		"includeDirs",
		"libraryDirs",
		"libraries",
		"frameworks",
		"sources",
	]) {
		if (value[key] !== undefined) nonEmptyStringArray(value[key], `${at}.${key}`);
	}
	if (value.defines !== undefined) {
		const defines = value.defines;
		expect(
			typeof defines === "object" &&
				defines !== null &&
				!Array.isArray(defines) &&
				Object.entries(defines).every(
					([name, definition]) =>
						/^[A-Za-z_]\w*$/.test(name) && typeof definition === "string",
				),
			`${at}.defines`,
			"a record of macro names to string values",
		);
	}
	if (
		value.pkgConfig === undefined &&
		value.libraries === undefined &&
		value.sources === undefined
	) {
		throw new SchemaViolation(`'${at}' must name pkgConfig, libraries, or sources`);
	}
}

/** The build config's `ffi` field: library names mapped to their contracts. */
export const ffiLibrariesLeaf: Leaf = {
	leaf: (value, at) => {
		expectObject(value, at);
		for (const [name, entry] of Object.entries(value)) {
			const entryAt = `${at}.${name}`;
			expect(
				LIBRARY_NAME.test(name),
				entryAt,
				"named by lowercase letters, digits, and _",
			);
			expectObject(entry, entryAt);
			expectKeys(entry, entryAt, ["contract", "find", "link"]);
			expect(
				typeof entry.contract === "string" && entry.contract.length > 0,
				`${entryAt}.contract`,
				"a non-empty string",
			);
			if (entry.find !== undefined) validateFind(entry.find, `${entryAt}.find`);
			if (entry.link !== undefined) {
				expect(
					entry.link === "static" || entry.link === "shared",
					`${entryAt}.link`,
					`"static" or "shared"`,
				);
			}
		}
	},
};

const C_NAME = /^[A-Za-z_]\w*$/;
const C_INTEGER_CONSTANT = /^(?:[A-Za-z_]\w*|-?(?:0[xX][0-9a-fA-F]+|\d+)[uUlL]*)$/;

/** Validate a record keyed by C names, checking each entry with `entry`. */
function namedRecord(
	value: unknown,
	at: string,
	entry: (value: unknown, at: string) => void,
): void {
	expectObject(value, at);
	for (const [name, item] of Object.entries(value)) {
		expect(C_NAME.test(name), `${at}.${name}`, "keyed by a C identifier");
		entry(item, `${at}.${name}`);
	}
}

function booleanField(value: Record<string, unknown>, key: string, at: string): void {
	if (value[key] !== undefined) {
		expect(typeof value[key] === "boolean", `${at}.${key}`, "a boolean");
	}
}

function validateEvidence(value: unknown, at: string): void {
	expect(Array.isArray(value) && value.length > 0, at, "a non-empty array");
	(value as Array<unknown>).forEach((reference, index) => {
		const entryAt = `${at}[${index}]`;
		expectObject(reference, entryAt);
		expectKeys(reference, entryAt, ["kind", "name"]);
		expect(
			typeof reference.kind === "string" &&
				["function", "global", "typedef", "struct", "union", "enum", "macro"].includes(
					reference.kind,
				),
			`${entryAt}.kind`,
			"function, global, typedef, struct, union, enum, or macro",
		);
		expect(
			typeof reference.name === "string" && C_NAME.test(reference.name),
			`${entryAt}.name`,
			"a C declaration name",
		);
	});
}

function validateShape(value: unknown, at: string): void {
	expectObject(value, at);
	if (value.tag !== undefined || value.cases !== undefined) {
		expectKeys(value, at, ["tag", "cases"]);
		expect(
			typeof value.tag === "string" && C_NAME.test(value.tag),
			`${at}.tag`,
			"a C field name",
		);
		expectObject(value.cases, `${at}.cases`);
		expect(
			Object.keys(value.cases).length > 0,
			`${at}.cases`,
			"at least one discriminator case",
		);
		for (const [key, selectors] of Object.entries(value.cases)) {
			expect(
				C_NAME.test(key) || /^(?:0|-?[1-9]\d*)$/.test(key),
				`${at}.cases.${key}`,
				"a C integer constant name or canonical decimal integer",
			);
			expect(
				Array.isArray(selectors) &&
					selectors.every(
						(selector: unknown) =>
							typeof selector === "string" &&
							selector.split(".").every((part) => C_NAME.test(part)),
					),
				`${at}.cases.${key}`,
				"an array of C member paths",
			);
		}
		return;
	}
	expectKeys(value, at, ["member"]);
	expect(
		typeof value.member === "string" && C_NAME.test(value.member),
		`${at}.member`,
		"a C union member name",
	);
}

function validateTypeFacts(value: unknown, at: string): void {
	expectObject(value, at);
	expectKeys(value, at, ["handle", "shape", "fields", "evidence"]);
	if (value.shape !== undefined) {
		validateShape(value.shape, `${at}.shape`);
		expect(value.handle === undefined, at, "a value shape or a handle");
	}
	if (value.evidence !== undefined) validateEvidence(value.evidence, `${at}.evidence`);
	if (value.fields !== undefined) {
		expectObject(value.fields, `${at}.fields`);
		for (const [name, field] of Object.entries(value.fields)) {
			const fieldAt = `${at}.fields.${name}`;
			expect(C_NAME.test(name), fieldAt, "a C field name");
			expectObject(field, fieldAt);
			expectKeys(field, fieldAt, ["bytes", "string", "callable"]);
			if (field.callable !== undefined) {
				expectKeys(field, fieldAt, ["callable"]);
				validateValueFacts(field, fieldAt);
				continue;
			}
			expect(
				(field.bytes !== undefined) !== (field.string !== undefined),
				fieldAt,
				"one of bytes or string",
			);
			const kind = field.string === undefined ? "bytes" : "string";
			const counted = field[kind];
			expectObject(counted, `${fieldAt}.${kind}`);
			expectKeys(
				counted,
				`${fieldAt}.${kind}`,
				kind === "bytes" ? ["length", "writable"] : ["length"],
			);
			expect(
				typeof counted.length === "string" && C_NAME.test(counted.length),
				`${fieldAt}.${kind}.length`,
				"a C field name",
			);
			if (kind === "bytes") booleanField(counted, "writable", `${fieldAt}.bytes`);
		}
	}
	if (value.handle === undefined) return;
	const handle = value.handle;
	expectObject(handle, `${at}.handle`);
	expectKeys(handle, `${at}.handle`, [
		"destroy",
		"collect",
		"storage",
		"views",
		"trailing",
		"layout",
	]);
	if (handle.layout !== undefined) {
		expectObject(handle.layout, `${at}.handle.layout`);
		expectKeys(handle.layout, `${at}.handle.layout`, ["size", "alignment"]);
		for (const key of ["size", "alignment"])
			expect(
				typeof handle.layout[key] === "string" && C_NAME.test(handle.layout[key]),
				`${at}.handle.layout.${key}`,
				"a C function name",
			);
		expect(handle.storage === "caller", `${at}.handle.layout`, 'storage: "caller"');
		expect(
			handle.trailing === undefined,
			`${at}.handle.layout`,
			"layout queries without a trailing field",
		);
	}
	if (handle.trailing !== undefined) {
		expect(
			typeof handle.trailing === "string" && C_NAME.test(handle.trailing),
			`${at}.handle.trailing`,
			"a C field name",
		);
		expect(handle.storage === "caller", `${at}.handle.trailing`, 'storage: "caller"');
	}
	if (handle.views !== undefined)
		expect(
			Array.isArray(handle.views) &&
				handle.views.every(
					(name: unknown) => typeof name === "string" && C_NAME.test(name),
				),
			`${at}.handle.views`,
			"an array of C type names",
		);
	if (handle.storage !== undefined) {
		expect(handle.storage === "caller", `${at}.handle.storage`, '"caller"');
		expect(
			handle.destroy === undefined && handle.collect !== true,
			`${at}.handle`,
			"explicit C initialization and cleanup for caller storage, without destroy or collect",
		);
	}
	if (handle.destroy !== undefined) {
		if (typeof handle.destroy === "string")
			expect(C_NAME.test(handle.destroy), `${at}.handle.destroy`, "a C function name");
		else {
			expectObject(handle.destroy, `${at}.handle.destroy`);
			expectKeys(handle.destroy, `${at}.handle.destroy`, ["function", "success"]);
			expect(
				typeof handle.destroy.function === "string" &&
					C_NAME.test(handle.destroy.function),
				`${at}.handle.destroy.function`,
				"a C function name",
			);
			expect(
				typeof handle.destroy.success === "string" &&
					C_INTEGER_CONSTANT.test(handle.destroy.success),
				`${at}.handle.destroy.success`,
				"a C identifier or integer literal",
			);
			expect(
				handle.collect !== true,
				`${at}.handle.collect`,
				"absent or false for cleanup that can fail and must be retried explicitly",
			);
		}
	}
	booleanField(handle, "collect", `${at}.handle`);
}

function validateCount(value: unknown, at: string, array = false): void {
	expectObject(value, at);
	expectKeys(value, at, array ? ["length", "capacity", "element"] : ["length"]);
	expect(
		typeof value.length === "string" &&
			(C_NAME.test(value.length) || /^[1-9]\d*$/.test(value.length)),
		`${at}.length`,
		"a parameter name or 1-based position",
	);
	if (value.capacity !== undefined)
		expect(
			typeof value.capacity === "string" &&
				(C_NAME.test(value.capacity) || /^[1-9]\d*$/.test(value.capacity)),
			`${at}.capacity`,
			"a parameter name or 1-based position",
		);
	if (value.element !== undefined) {
		const element = value.element;
		expectObject(element, `${at}.element`);
		expectKeys(element, `${at}.element`, ["string", "bytes"]);
		expect(
			(element.string === true && element.bytes === undefined) ||
				(element.bytes === true && element.string === undefined),
			`${at}.element`,
			"one of string: true or bytes: true",
		);
	}
}

function validateValueFacts(value: unknown, at: string): void {
	expectObject(value, at);
	expectKeys(value, at, [
		"shape",
		"nullable",
		"borrowed",
		"fresh",
		"out",
		"inout",
		"string",
		"bytes",
		"array",
		"free",
		"callback",
		"callable",
		"constant",
		"sizeof",
	]);
	if (value.shape !== undefined) validateShape(value.shape, `${at}.shape`);
	for (const key of ["nullable", "borrowed", "fresh", "out", "inout"]) {
		booleanField(value, key, at);
	}
	if (value.string !== undefined && typeof value.string !== "boolean")
		validateCount(value.string, `${at}.string`);
	expect(
		Number(value.string !== undefined && value.string !== false) +
			Number(value.bytes !== undefined) +
			Number(value.array !== undefined) <=
			1,
		at,
		"one of string, bytes, or array",
	);
	if (value.bytes !== undefined) validateCount(value.bytes, `${at}.bytes`);
	if (value.array !== undefined) {
		validateCount(value.array, `${at}.array`, true);
		if ((value.array as Record<string, unknown>).capacity !== undefined)
			expect(
				value.out === true && value.inout !== true,
				`${at}.array.capacity`,
				"an out array buffer",
			);
	}
	if (value.callable !== undefined) {
		const callable = value.callable;
		expectObject(callable, `${at}.callable`);
		expectKeys(callable, `${at}.callable`, ["lifetime", "params", "returns"]);
		expect(
			callable.lifetime === "library" || callable.lifetime === "owner",
			`${at}.callable.lifetime`,
			"'library' or 'owner'",
		);
		if (callable.params !== undefined) {
			expectObject(callable.params, `${at}.callable.params`);
			for (const [position, facts] of Object.entries(callable.params)) {
				expect(
					/^[1-9]\d*$/.test(position),
					`${at}.callable.params.${position}`,
					"a 1-based position",
				);
				validateValueFacts(facts, `${at}.callable.params.${position}`);
			}
		}
		if (callable.returns !== undefined)
			validateValueFacts(callable.returns, `${at}.callable.returns`);
	}
	if (value.callback !== undefined) {
		const callback = value.callback;
		expectObject(callback, `${at}.callback`);
		expectKeys(callback, `${at}.callback`, [
			"data",
			"release",
			"params",
			"replaced",
			"lookup",
			"queued",
			"closes",
			"returns",
		]);
		if (callback.returns !== undefined) {
			const result = callback.returns;
			expectObject(result, `${at}.callback.returns`);
			expectKeys(result, `${at}.callback.returns`, [
				"shape",
				"string",
				"bytes",
				"nullable",
				"lifetime",
			]);
			if (result.shape !== undefined)
				expectKeys(result, `${at}.callback.returns`, ["shape"]);
			const { lifetime, ...facts } = result;
			expect(
				result.shape !== undefined
					? lifetime === undefined
					: lifetime === "call" || lifetime === "registration",
				`${at}.callback.returns.lifetime`,
				result.shape !== undefined
					? "absent for a value shape"
					: "'call' or 'registration'",
			);
			validateValueFacts(facts, `${at}.callback.returns`);
		}
		if (callback.lookup !== undefined) {
			const lookup = callback.lookup;
			expectObject(lookup, `${at}.callback.lookup`);
			expectKeys(lookup, `${at}.callback.lookup`, ["function", "param"]);
			expect(
				typeof lookup.function === "string" && C_NAME.test(lookup.function),
				`${at}.callback.lookup.function`,
				"a C function name",
			);
			expect(
				typeof lookup.param === "string" && /^[1-9]\d*$/.test(lookup.param),
				`${at}.callback.lookup.param`,
				"a 1-based position",
			);
			expect(
				callback.data !== undefined,
				`${at}.callback.data`,
				"the parameter whose value the lookup returns",
			);
		}
		booleanField(callback, "replaced", `${at}.callback`);
		expect(
			callback.replaced !== true || callback.release === undefined,
			`${at}.callback.release`,
			"absent for a replaced callback, which the next call releases",
		);
		expect(
			callback.queued === undefined ||
				typeof callback.queued === "boolean" ||
				callback.queued === "wait",
			`${at}.callback.queued`,
			"a boolean or 'wait'",
		);
		if (callback.closes !== undefined) {
			expect(
				callback.release === undefined && callback.replaced !== true,
				`${at}.callback.closes`,
				"a one-shot callback without release or replaced",
			);
			expect(
				callback.queued !== false,
				`${at}.callback.queued`,
				"enabled for a close completion",
			);
		}
		expect(
			(callback.queued !== true && callback.queued !== "wait") ||
				callback.release !== undefined ||
				callback.replaced === true ||
				callback.closes !== undefined,
			`${at}.callback.queued`,
			"on a callback the library keeps, with release, replaced, or closes",
		);
		if (callback.params !== undefined) {
			expectObject(callback.params, `${at}.callback.params`);
			for (const [key, facts] of Object.entries(callback.params)) {
				expect(
					/^[1-9]\d*$/.test(key),
					`${at}.callback.params.${key}`,
					"keyed by 1-based position",
				);
				validateValueFacts(facts, `${at}.callback.params.${key}`);
			}
		}
		expect(
			callback.release === undefined || callback.data !== undefined,
			`${at}.callback.data`,
			"the parameter whose value the release destructor receives",
		);
		for (const key of ["data", "release", "closes"] as const) {
			const reference = callback[key];
			if (reference === undefined) continue;
			expect(
				typeof reference === "string" &&
					(C_NAME.test(reference) || /^[1-9]\d*$/.test(reference)),
				`${at}.callback.${key}`,
				"a parameter name or 1-based position",
			);
		}
	}
	if (value.constant !== undefined) {
		expect(
			typeof value.constant === "string" && C_INTEGER_CONSTANT.test(value.constant),
			`${at}.constant`,
			"a C identifier or integer literal",
		);
	}
	if (value.sizeof !== undefined)
		expect(
			typeof value.sizeof === "string" && C_NAME.test(value.sizeof),
			`${at}.sizeof`,
			"a C type name",
		);
	if (value.free !== undefined) {
		expect(
			typeof value.free === "string" && C_NAME.test(value.free),
			`${at}.free`,
			"a C function name",
		);
	}
}

function validateParamFacts(value: unknown, at: string): void {
	expectObject(value, at);
	for (const [name, facts] of Object.entries(value)) {
		expect(
			C_NAME.test(name) || /^[1-9]\d*$/.test(name),
			`${at}.${name}`,
			"keyed by a parameter name or 1-based position",
		);
		validateValueFacts(facts, `${at}.${name}`);
	}
}

function validateFunctionFacts(value: unknown, at: string): void {
	expectObject(value, at);
	expectKeys(value, at, ["params", "returns", "variants", "async", "evidence"]);
	if (value.evidence !== undefined) validateEvidence(value.evidence, `${at}.evidence`);
	if (value.params !== undefined) validateParamFacts(value.params, `${at}.params`);
	if (value.async !== undefined) {
		expect(
			typeof value.async === "string" && C_NAME.test(value.async),
			`${at}.async`,
			"a function name",
		);
		expect(value.variants === undefined, `${at}.async`, "absent beside variants");
	}
	if (value.returns !== undefined) validateValueFacts(value.returns, `${at}.returns`);
	if (value.variants !== undefined) {
		expectObject(value.variants, `${at}.variants`);
		for (const [name, variant] of Object.entries(value.variants)) {
			const variantAt = `${at}.variants.${name}`;
			expect(C_NAME.test(name), variantAt, "keyed by a function name");
			expectObject(variant, variantAt);
			expectKeys(variant, variantAt, ["args", "params"]);
			expect(
				Array.isArray(variant.args) &&
					variant.args.length > 0 &&
					variant.args.every((spelling) => typeof spelling === "string"),
				`${variantAt}.args`,
				"a non-empty array of C type spellings",
			);
			if (variant.params !== undefined) {
				validateParamFacts(variant.params, `${variantAt}.params`);
			}
		}
	}
}

function validateGlobalFacts(value: unknown, at: string): void {
	expectObject(value, at);
	expectKeys(value, at, ["get", "set", "value", "evidence"]);
	expect(
		value.get !== undefined || value.set !== undefined,
		at,
		"a getter or setter export",
	);
	for (const key of ["get", "set"] as const)
		if (value[key] !== undefined) {
			const name = value[key];
			let valid = false;
			if (typeof name === "string" && C_NAME.test(name)) {
				try {
					parseModule(`export function ${name}() {}`);
					valid = true;
				} catch {
					valid = false;
				}
			}
			expect(valid, `${at}.${key}`, "a JavaScript function export name");
		}
	if (value.value !== undefined) {
		expectObject(value.value, `${at}.value`);
		expectKeys(value.value, `${at}.value`, [
			"shape",
			"borrowed",
			"callable",
			"string",
			"bytes",
		]);
		const { bytes, ...conversion } = value.value;
		if (bytes !== undefined)
			expect(bytes === true, `${at}.value.bytes`, "true for a fixed byte array");
		if (conversion.string !== undefined)
			expect(conversion.string === true, `${at}.value.string`, "true for UTF-8 text");
		expect(
			bytes !== true || conversion.string !== true,
			`${at}.value`,
			"one of string or bytes",
		);
		validateValueFacts(conversion, `${at}.value`);
		if (conversion.borrowed !== undefined || conversion.callable !== undefined)
			expect(
				value.get !== undefined,
				`${at}.value`,
				"a getter for borrowed or callable values",
			);
	}
	if (value.evidence !== undefined) validateEvidence(value.evidence, `${at}.evidence`);
}

const CONTRACT_SCHEMA: ObjectSchema = {
	object: {
		headers: {
			leaf: (value, at) => {
				nonEmptyStringArray(value, at);
				expect((value as Array<string>).length > 0, at, "a non-empty array");
				for (const header of value as Array<string>) {
					expect(
						!/["\n\\]/.test(header),
						at,
						"header names without quotes or backslashes",
					);
				}
			},
		},
		find: {
			leaf: (value, at) => {
				expect(Array.isArray(value), at, "an array");
				(value as Array<unknown>).forEach((entry, index) =>
					validateFind(entry, `${at}[${index}]`),
				);
			},
		},
		types: { leaf: (value, at) => namedRecord(value, at, validateTypeFacts) },
		functions: { leaf: (value, at) => namedRecord(value, at, validateFunctionFacts) },
		globals: { leaf: (value, at) => namedRecord(value, at, validateGlobalFacts) },
	},
};

/** A discovery description with paths made absolute against its declaring file. */
export interface ResolvedFind {
	readonly pkgConfig?: string;
	readonly includeDirs: ReadonlyArray<string>;
	readonly defines: Readonly<Record<string, string>>;
	readonly libraryDirs: ReadonlyArray<string>;
	readonly libraries: ReadonlyArray<string>;
	readonly frameworks: ReadonlyArray<string>;
	readonly sources: ReadonlyArray<string>;
}

export function resolveFind(find: MaligatorFfiFind, baseDirectory: string): ResolvedFind {
	const absolute = (paths: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
		(paths ?? []).map((entry) => path.resolve(baseDirectory, entry));
	return {
		...(find.pkgConfig === undefined ? {} : { pkgConfig: find.pkgConfig }),
		includeDirs: absolute(find.includeDirs),
		defines: { ...find.defines },
		libraryDirs: absolute(find.libraryDirs),
		libraries: [...(find.libraries ?? [])],
		frameworks: [...(find.frameworks ?? [])],
		sources: absolute(find.sources),
	};
}

/** The facts a contract states, shaped as the contract spells them. */
export interface LibraryFacts {
	readonly types: Readonly<Record<string, MaligatorFfiTypeFacts>>;
	readonly functions: Readonly<Record<string, MaligatorFfiFunctionFacts>>;
	readonly globals?: Readonly<Record<string, MaligatorFfiGlobalFacts>>;
}

export interface LibraryContract {
	readonly name: string;
	readonly path: string;
	readonly headers: ReadonlyArray<string>;
	readonly facts: LibraryFacts;
	/** Discovery alternatives in order: the build config's override, else the contract's. */
	readonly find: ReadonlyArray<ResolvedFind>;
	readonly link: "static" | "shared" | undefined;
}

/**
 * Load the contract a build config names for `name`. Contract paths resolve against
 * the project root; paths inside a contract resolve against the contract's directory.
 */
export function loadLibraryContract(
	name: string,
	library: MaligatorFfiLibrary,
	projectRoot: string,
	stripTypes: BuildConfigTypeStripper,
): LibraryContract {
	const contractPath = path.resolve(projectRoot, library.contract);
	const label = path.relative(projectRoot, contractPath) || contractPath;
	if (!existsSync(contractPath)) {
		throw new BuildConfigError(`ffi.${name}.contract: file not found: ${contractPath}`);
	}
	const value = evaluateDefinitionModule(
		readFileSync(contractPath, "utf-8"),
		contractPath,
		{ label, helper: "defineLibrary", noun: "contract" },
		stripTypes,
	);
	validateDefinition(value, CONTRACT_SCHEMA, label);
	const contract = value as MaligatorLibraryContract;
	if (contract.headers === undefined) {
		throw new BuildConfigError(`${label}: 'headers' is required`);
	}
	const find =
		library.find !== undefined
			? [resolveFind(library.find, projectRoot)]
			: (contract.find ?? []).map((entry) =>
					resolveFind(entry, path.dirname(contractPath)),
				);
	if (find.length === 0) {
		throw new BuildConfigError(
			`ffi.${name}: neither the build config nor ${label} says how to find the library`,
		);
	}
	return {
		name,
		path: contractPath,
		headers: [...contract.headers],
		facts: {
			types: { ...contract.types },
			functions: { ...contract.functions },
			...(contract.globals === undefined ? {} : { globals: { ...contract.globals } }),
		},
		find,
		link: library.link,
	};
}
