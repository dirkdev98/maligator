import {
	NO_EFFECT_SUMMARY,
	EVERY_EFFECT_SUMMARY,
} from "../compiler/shared/effect-summary.ts";
import type { EffectSummary } from "../compiler/shared/effect-summary.ts";

export type PlatformData =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<PlatformData>
	| { readonly [key: string]: PlatformData };

export type PlatformType =
	| { readonly kind: "signature"; readonly source: string }
	| { readonly kind: "primitive"; readonly name: "string" | "number" | "boolean" }
	| { readonly kind: "literal"; readonly value: string | boolean | null }
	| { readonly kind: "reference"; readonly name: string }
	| { readonly kind: "array"; readonly element: PlatformType }
	| { readonly kind: "record"; readonly value: PlatformType }
	| { readonly kind: "object"; readonly properties: ReadonlyArray<PlatformProperty> }
	| {
			readonly kind: "union" | "intersection";
			readonly types: ReadonlyArray<PlatformType>;
	  };

export interface PlatformDocumentation {
	readonly description: string;
	readonly examples?: ReadonlyArray<string>;
}

export interface PlatformProperty extends PlatformDocumentation {
	readonly name: string;
	readonly type: PlatformType;
}

export type PlatformTypeDefinition = PlatformProperty;

export interface PlatformExport extends PlatformDocumentation {
	readonly name: string;
	readonly type: PlatformType;
	readonly contract: {
		readonly phase: "preparation" | "runtime";
		readonly value: "deep-frozen-data" | "callable";
		readonly identity: "application-context" | "module";
		readonly provider?: "execution";
		readonly effects: EffectSummary;
	};
}

interface PlatformModuleDefinition extends PlatformDocumentation {
	readonly id: `maligator:${string}`;
	readonly stability: "experimental";
	readonly evaluation: "side-effect-free";
	readonly declarationFile: string;
	readonly types: ReadonlyArray<PlatformTypeDefinition>;
	readonly exports: ReadonlyArray<PlatformExport>;
}

export type PlatformModule = PlatformModuleDefinition &
	(
		| { readonly kind: "native"; readonly installer: string }
		| { readonly kind: "source"; readonly sourceFile: string }
	);

const string: PlatformType = { kind: "primitive", name: "string" };
const number: PlatformType = { kind: "primitive", name: "number" };
const boolean: PlatformType = { kind: "primitive", name: "boolean" };
const reference = (name: string): PlatformType => ({ kind: "reference", name });
const literal = (value: string | boolean | null): PlatformType => ({
	kind: "literal",
	value,
});
const union = (...types: Array<PlatformType>): PlatformType => ({ kind: "union", types });
const array = (element: PlatformType): PlatformType => ({ kind: "array", element });
const object = (properties: Array<PlatformProperty>): PlatformType => ({
	kind: "object",
	properties,
});
const property = (
	name: string,
	type: PlatformType,
	description: string,
): PlatformProperty => ({ name, type, description });

const executionTypes: ReadonlyArray<PlatformTypeDefinition> = [
	property(
		"ExecutionProfile",
		union(literal("none"), literal("sampling"), literal("compiler")),
		"Profiling instrumentation: none by default; sampling for --profile; compiler for --profile=compiler. Both profiling modes select full optimization without selecting production application behavior.",
	),
	property(
		"ExecutionTarget",
		object([
			property(
				"platform",
				union(literal("darwin"), literal("linux"), literal("wasi")),
				"Application operating-system target, not the compiler host. Native builds use darwin or linux; WebAssembly uses wasi.",
			),
			property(
				"arch",
				union(literal("arm64"), literal("x64"), literal("wasm32")),
				"Application architecture. Cross builds report the destination architecture.",
			),
			property(
				"triple",
				string,
				"Resolved target triple, including when --target was omitted; for example aarch64-apple-darwin.",
			),
		]),
		"The fixed platform contract of the application image.",
	),
	property(
		"ExecutionOptions",
		object([
			property(
				"profile",
				reference("ExecutionProfile"),
				"Selected application profiling instrumentation. Defaults to none; does not imply execution.production.",
			),
		]),
		"Options shared by build, run, and dev. Output paths, verbosity, and compiler scheduling are tool settings and are not exposed.",
	),
	property(
		"TestExecutionOptions",
		object([
			property(
				"profile",
				reference("ExecutionProfile"),
				"Selected test profiling instrumentation. Defaults to none; profiling preserves command: test.",
			),
			property(
				"nameFilter",
				union(string, literal(null)),
				"Hierarchical test-name filter from --run, or null when all discovered names are eligible.",
			),
			property(
				"repeat",
				number,
				"Number of requested test repetitions from --repeat; defaults to 1. This is not the currently executing repetition.",
			),
			property(
				"bail",
				boolean,
				"Whether --bail stops the test run after its first failure. Defaults to false.",
			),
			property(
				"timeoutMs",
				number,
				"Default test timeout in milliseconds from --timeout. Defaults to 5000; individual test APIs can select a different timeout.",
			),
			property(
				"shuffleSeed",
				union(number, literal(null)),
				"Resolved positive shuffle seed, or null when shuffling is disabled. --shuffle without a seed chooses it once before compilation; the same seed drives execution and cache identity.",
			),
		]),
		"Normalized test settings, fixed for the application image. Changing these values invalidates specialized test artifacts.",
	),
	property(
		"ExecutionEngineConfig",
		object([
			property(
				"primordials",
				union(literal("locked"), literal("mutable")),
				"Requested primordial mutation policy. Defaults to locked. The execution snapshot itself is immutable in either policy.",
			),
			property(
				"eval",
				union(boolean, literal("compile-check")),
				"Dynamic compilation policy. false (default) rejects eval/Function execution at runtime; true enables the runtime compiler; compile-check additionally rejects statically visible dynamic compilation calls.",
			),
			property(
				"realms",
				boolean,
				"Whether additional realms are enabled. Defaults to false.",
			),
			property(
				"regexp",
				boolean,
				"Whether regular expressions are enabled. Defaults to true.",
			),
			property(
				"temporal",
				boolean,
				"Whether Temporal and its required data are enabled. Defaults to false.",
			),
			property(
				"intl",
				object([
					property("enabled", boolean, "Whether Intl is enabled. Defaults to false."),
					property(
						"features",
						array(string),
						"Requested Intl service names. An empty array selects the default complete service set when Intl is enabled; it does not mean every service survived tree shaking.",
					),
					property(
						"languages",
						array(string),
						"Requested locale selection. Defaults to an empty array. Unsupported locale selections are rejected by configuration validation.",
					),
				]),
				"Requested Intl policy after applying configuration defaults.",
			),
		]),
		"Resolved engine policies. These describe build inputs, never post-DCE native feature inclusion.",
	),
	property(
		"ExecutionConfig",
		object([
			property(
				"engine",
				reference("ExecutionEngineConfig"),
				"Engine configuration after validation and default resolution.",
			),
			property(
				"surface",
				object([
					property(
						"webPlatform",
						boolean,
						"Whether Web globals are requested. Defaults to false; native module imports are independent of this global installation policy.",
					),
					property(
						"node",
						boolean,
						"Whether Node compatibility, globals, and node: module resolution are requested. Defaults to false.",
					),
				]),
				"Global and compatibility surface policy. maligator:process requires no enable flag.",
			),
			property(
				"modules",
				object([
					property(
						"aliases",
						{ kind: "record", value: string },
						"Exact module-specifier replacements from configuration. Defaults to an empty object. Alias entries are immutable own data properties.",
					),
				]),
				"Resolved module-resolution policy.",
			),
		]),
		"Public application policies from the selected build configuration. Excludes build-host paths, asset declarations, output controls, and the obsolete Maligator surface switch.",
	),
	property(
		"ExecutionCommon",
		object([
			property(
				"production",
				boolean,
				"Explicit production application intent. True only when production was selected for the application; independent of NODE_ENV, profiling, and optimization. Currently --production is a build option. Defaults to false.",
			),
			property(
				"compiled",
				boolean,
				"Whether the application image executes as native compiled code. A native executable hosting an interpreted image reports false. This is fixed for the image, not a query about the current stack frame or an eval-created function.",
			),
			property(
				"optimization",
				union(literal("development"), literal("full")),
				"Actual selected frontend optimization policy. Ordinary commands currently use development; production builds and profiling use full. Backend choice is independent.",
			),
			property(
				"target",
				reference("ExecutionTarget"),
				"Resolved application target. The compiler's host platform is not substituted during a cross build.",
			),
			property(
				"config",
				reference("ExecutionConfig"),
				"Validated configuration policies with defaults applied, captured before compilation.",
			),
		]),
		"Fields shared by every execution workflow. All nested objects and arrays are deeply frozen at runtime.",
	),
	property(
		"Execution",
		{
			kind: "intersection",
			types: [
				reference("ExecutionCommon"),
				union(
					object([
						property(
							"command",
							literal("build"),
							"Prepared by maligator build. Remains build when the resulting executable runs later; application statements are not executed by the build itself.",
						),
						property(
							"options",
							reference("ExecutionOptions"),
							"Normalized build options relevant to application execution.",
						),
					]),
					object([
						property(
							"command",
							union(literal("run"), literal("dev")),
							"Prepared by maligator run or maligator dev. dev denotes the watch/restart workflow even when profiling selects native compilation.",
						),
						property(
							"options",
							reference("ExecutionOptions"),
							"Normalized run/dev options. Arguments after -- remain runtime argv and do not specialize application compilation.",
						),
					]),
					object([
						property(
							"command",
							literal("test"),
							"Prepared by maligator test. Preserved for interpreted tests, profiled native tests, and every fragment of the test application.",
						),
						property(
							"options",
							reference("TestExecutionOptions"),
							"Normalized test options. Narrow command to test before accessing test-only fields.",
						),
					]),
				),
			],
		},
		"An immutable application-image description, discriminated by command. The command describes the workflow that prepared the image, not a transient process phase.",
	),
];

export const PLATFORM_CATALOG_VERSION = 1;

export const PLATFORM_MODULES: ReadonlyArray<PlatformModule> = [
	{
		kind: "native",
		id: "maligator:process",
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_process",
		declarationFile: "process-api.d.ts",
		description:
			"Application execution context. Importing this module has no externally observable effects and requires no configuration switch. Unused exports and native implementation dependencies are eliminated. Process arguments, environment, working directory, and PID are runtime concerns outside execution.",
		types: executionTypes,
		exports: [
			{
				name: "execution",
				type: reference("Execution"),
				description:
					"The canonical execution description, fixed before application compilation. Reads of known own properties, import aliases and re-exports, immutable aliases and destructuring, primitive comparisons, boolean expressions, and if/switch branches specialize in development and full compilation. Dynamic keys and opaque calls remain ordinary JavaScript and may retain the runtime object. The snapshot has stable identity within an application context and deeply frozen own data properties; reflection sees the complete shape. Static and dynamic imports return the same export. A different command, option, configuration, target, or backend creates a different compilation context. Profiling does not change production intent. Importing the module does not keep unused native code alive.",
				examples: [
					'import { execution } from "maligator:process";\n\nif (execution.compiled && execution.production) {\n  console.log("native production application");\n}',
					'import { execution } from "maligator:process";\n\nif (execution.command === "test") {\n  console.log(execution.options.repeat);\n}',
				],
				contract: {
					phase: "preparation",
					value: "deep-frozen-data",
					identity: "application-context",
					provider: "execution",
					effects: NO_EFFECT_SUMMARY,
				},
			},
		],
	},

	{
		kind: "source",
		id: "maligator:test",
		stability: "experimental",
		evaluation: "side-effect-free",
		sourceFile: "testing/runtime.mjs",
		declarationFile: "test-api.d.ts",
		description:
			"Test authoring and assertions. Importing this module does not register tests or install runner globals. Registration and assertions are ordinary effectful calls; the test command initializes its internal runner explicitly. Unused imports can be eliminated.",
		types: [
			{
				name: "TestCallback",
				type: {
					kind: "signature",
					source: "() => unknown",
				},
				description:
					"A test or hook body. Maligator waits for a returned promise or thenable before advancing the lifecycle.",
			},
			{
				name: "HookCallback",
				type: {
					kind: "signature",
					source: "TestCallback",
				},
				description:
					"A lifecycle hook body, with the same async completion contract as a test.",
			},
			{
				name: "Constructor",
				type: {
					kind: "signature",
					source: "abstract new (...args: Array<never>) => unknown",
				},
				description: "A constructable value accepted by {@link expect.any}.",
			},
			{
				name: "AsymmetricMatcher",
				type: {
					kind: "signature",
					source: "{\n\t\treadonly __maligator_asymmetric__: string;\n\t}",
				},
				description:
					"Opaque partial-match value produced by helpers such as {@link expect.objectContaining}. It may be nested inside `toEqual`, `toStrictEqual`, and `toMatchObject` expectations.",
			},
			{
				name: "Matchers",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Negate the following matcher. */\n\t\treadonly not: Matchers;\n\t\t/** Wait for the received promise to fulfill, then match its value. */\n\t\treadonly resolves: AsyncMatchers;\n\t\t/** Wait for the received promise to reject, then match its reason. */\n\t\treadonly rejects: AsyncMatchers;\n\t\t/** Require ECMAScript `Object.is` identity. */\n\t\ttoBe(expected: unknown): void;\n\t\t/** Recursively compare enumerable object properties and array elements. */\n\t\ttoEqual(expected: unknown): void;\n\t\t/**\n\t\t * Recursively compare values while also requiring matching prototypes and\n\t\t * matching sparse-array holes.\n\t\t */\n\t\ttoStrictEqual(expected: unknown): void;\n\t\t/** Require a value other than `undefined`. */\n\t\ttoBeDefined(): void;\n\t\t/** Require `undefined`. */\n\t\ttoBeUndefined(): void;\n\t\t/** Require `null`. */\n\t\ttoBeNull(): void;\n\t\t/** Require a truthy value. */\n\t\ttoBeTruthy(): void;\n\t\t/** Require a falsy value. */\n\t\ttoBeFalsy(): void;\n\t\t/** Require a string substring or an array element matched by identity. */\n\t\ttoContain(expected: unknown): void;\n\t\t/** Require a numeric `.length` equal to `expected`. */\n\t\ttoHaveLength(expected: number): void;\n\t\t/** Match a string against a substring or regular expression. */\n\t\ttoMatch(expected: string | RegExp): void;\n\t\t/** Recursively require the enumerable properties present in `expected`. */\n\t\ttoMatchObject(expected: object): void;\n\t\t/**\n\t\t * Invoke the received function and require it to throw. The optional\n\t\t * expectation may be a message substring, regular expression, error\n\t\t * constructor, or error instance.\n\t\t */\n\t\ttoThrow(\n\t\t\texpected?:\n\t\t\t\t| string\n\t\t\t\t| RegExp\n\t\t\t\t| Error\n\t\t\t\t| (abstract new (...args: Array<never>) => Error),\n\t\t): void;\n\t}",
				},
				description: "Matchers for a synchronously received value.",
			},
			{
				name: "AsyncMatchers",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Negate the following asynchronous matcher. */\n\t\treadonly not: AsyncMatchers;\n\t\ttoBe(expected: unknown): Promise<void>;\n\t\ttoEqual(expected: unknown): Promise<void>;\n\t\ttoStrictEqual(expected: unknown): Promise<void>;\n\t\ttoBeDefined(): Promise<void>;\n\t\ttoBeUndefined(): Promise<void>;\n\t\ttoBeNull(): Promise<void>;\n\t\ttoBeTruthy(): Promise<void>;\n\t\ttoBeFalsy(): Promise<void>;\n\t\ttoContain(expected: unknown): Promise<void>;\n\t\ttoHaveLength(expected: number): Promise<void>;\n\t\ttoMatch(expected: string | RegExp): Promise<void>;\n\t\ttoMatchObject(expected: object): Promise<void>;\n\t\ttoThrow(\n\t\t\texpected?:\n\t\t\t\t| string\n\t\t\t\t| RegExp\n\t\t\t\t| Error\n\t\t\t\t| (abstract new (...args: Array<never>) => Error),\n\t\t): Promise<void>;\n\t}",
				},
				description:
					"Promise-returning matcher surface exposed by {@link Matchers.resolves} and {@link Matchers.rejects}. Await these calls so the test cannot finish before the assertion.",
			},
			{
				name: "ExpectFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Create matchers for `received`. The assertion position is captured here. */\n\t\t(received: unknown): Matchers;\n\t\t/** Match a primitive of the corresponding built-in kind or an instance. */\n\t\tany(constructorValue: Constructor): AsymmetricMatcher;\n\t\t/** Match any value except `null` and `undefined`. */\n\t\tanything(): AsymmetricMatcher;\n\t\t/** Match a string containing `pattern` or satisfying the regular expression. */\n\t\tstringMatching(pattern: string | RegExp): AsymmetricMatcher;\n\t\t/** Match an object containing all recursively matched properties in `value`. */\n\t\tobjectContaining(value: object): AsymmetricMatcher;\n\t\t/** Match an array containing a match for every element in `value`. */\n\t\tarrayContaining(value: Array<unknown>): AsymmetricMatcher;\n\t}",
				},
				description:
					"Assertion entrypoint and Maligator-owned asymmetric matcher factories.",
			},
			{
				name: "TestFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Register a test. Returned promises are awaited by the runner. */\n\t\t(name: string, callback: TestCallback): void;\n\t\t/** Register a skipped test without invoking its callback. */\n\t\tskip(name: string, callback: TestCallback): void;\n\t\t/** Register a named placeholder with no callback. */\n\t\ttodo(name: string): void;\n\t\t/**\n\t\t * Register a focused test. When any `.only` exists, non-focused tests are\n\t\t * skipped and the runner emits a warning.\n\t\t */\n\t\tonly(name: string, callback: TestCallback): void;\n\t\t/**\n\t\t * Register one test for each row. Use `%#` in `name` for the zero-based row\n\t\t * index. Array rows are spread into callback parameters.\n\t\t */\n\t\teach<const Row extends ReadonlyArray<unknown>>(\n\t\t\trows: ReadonlyArray<Row>,\n\t\t): (name: string, callback: (...values: [...Row]) => unknown) => void;\n\t}",
				},
				description: "Register tests in the current suite during module evaluation.",
			},
			{
				name: "DescribeFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Register a suite. Suite callbacks must not return a promise. */\n\t\t(name: string, callback: () => void): void;\n\t\t/** Register a suite whose descendants are skipped. */\n\t\tskip(name: string, callback: () => void): void;\n\t\t/** Register a focused suite and emit the runner's focused-test warning. */\n\t\tonly(name: string, callback: () => void): void;\n\t}",
				},
				description: "Register nested suites synchronously during module evaluation.",
			},
		],
		exports: [
			{
				name: "test",
				type: {
					kind: "reference",
					name: "TestFunction",
				},
				description: "Register a test in the current suite.",
			},
			{
				name: "describe",
				type: {
					kind: "reference",
					name: "DescribeFunction",
				},
				description: "Register a nested suite in the current suite.",
			},
			{
				name: "expect",
				type: {
					kind: "reference",
					name: "ExpectFunction",
				},
				description: "Create fluent matchers for a received value.",
			},
			{
				name: "beforeAll",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description: "Run once before tests in the current suite.",
			},
			{
				name: "afterAll",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run once after tests in the current suite, including after test failures.",
			},
			{
				name: "beforeEach",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run before every selected descendant test. Ancestor hooks run before hooks\ndeclared by a nested suite.",
			},
			{
				name: "afterEach",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run after every selected descendant test. Nested-suite hooks run before\nancestor hooks.",
			},
		].map((entry): PlatformExport => ({
			...entry,
			type: entry.type as PlatformType,
			contract: {
				phase: "runtime",
				value: "callable",
				identity: "module",
				effects: EVERY_EFFECT_SUMMARY,
			},
		})),
	},
];

export function lookupPlatformModule(specifier: string): PlatformModule | undefined {
	return PLATFORM_MODULES.find((module) => module.id === specifier);
}

/** Validate provider data against the same schema that generates the public types. */
export function validatePlatformValue(
	module: PlatformModule,
	type: PlatformType,
	value: unknown,
): value is PlatformData {
	switch (type.kind) {
		case "signature":
			return false;
		case "primitive":
			return (
				typeof value === type.name && (type.name !== "number" || Number.isFinite(value))
			);
		case "literal":
			return value === type.value;
		case "reference": {
			const definition = module.types.find((entry) => entry.name === type.name);
			if (!definition) throw new Error(`Unknown platform type ${module.id}/${type.name}`);
			return validatePlatformValue(module, definition.type, value);
		}
		case "array":
			return (
				Array.isArray(value) &&
				value.every((item: unknown) => validatePlatformValue(module, type.element, item))
			);
		case "record":
			return (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.values(value).every((item: unknown) =>
					validatePlatformValue(module, type.value, item),
				)
			);
		case "object":
			return (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				type.properties.every(
					(entry) =>
						Object.hasOwn(value, entry.name) &&
						validatePlatformValue(
							module,
							entry.type,
							(value as Record<string, unknown>)[entry.name],
						),
				)
			);
		case "union":
			return type.types.some((entry) => validatePlatformValue(module, entry, value));
		case "intersection":
			return type.types.every((entry) => validatePlatformValue(module, entry, value));
	}
}
