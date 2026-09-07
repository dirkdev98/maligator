// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Application execution context. Importing this module has no externally observable
 * effects and requires no configuration switch. Unused exports and native
 * implementation dependencies are eliminated. Process arguments, environment, working
 * directory, and PID are runtime concerns outside execution.
 */
declare module "maligator:process" {
	/**
	 * Profiling instrumentation: none by default; sampling for --profile; compiler for
	 * --profile=compiler. Both profiling modes select full optimization without
	 * selecting production application behavior.
	 */
	export type ExecutionProfile = "none" | "sampling" | "compiler";

	/**
	 * The fixed platform contract of the application image.
	 */
	export type ExecutionTarget = {
		/**
		 * Application operating-system target, not the compiler host. Native builds use
		 * darwin or linux; WebAssembly uses wasi.
		 */
		readonly platform: "darwin" | "linux" | "wasi";
		/**
		 * Application architecture. Cross builds report the destination architecture.
		 */
		readonly arch: "arm64" | "x64" | "wasm32";
		/**
		 * Resolved target triple, including when --target was omitted; for example
		 * aarch64-apple-darwin.
		 */
		readonly triple: string;
	};

	/**
	 * Options shared by build, run, and dev. Output paths, verbosity, and compiler
	 * scheduling are tool settings and are not exposed.
	 */
	export type ExecutionOptions = {
		/**
		 * Selected application profiling instrumentation. Defaults to none; does not imply
		 * execution.production.
		 */
		readonly profile: ExecutionProfile;
	};

	/**
	 * Normalized test settings, fixed for the application image. Changing these values
	 * invalidates specialized test artifacts.
	 */
	export type TestExecutionOptions = {
		/**
		 * Selected test profiling instrumentation. Defaults to none; profiling preserves
		 * command: test.
		 */
		readonly profile: ExecutionProfile;
		/**
		 * Hierarchical test-name filter from --run, or null when all discovered names are
		 * eligible.
		 */
		readonly nameFilter: string | null;
		/**
		 * Number of requested test repetitions from --repeat; defaults to 1. This is not
		 * the currently executing repetition.
		 */
		readonly repeat: number;
		/**
		 * Whether --bail stops the test run after its first failure. Defaults to false.
		 */
		readonly bail: boolean;
		/**
		 * Default test timeout in milliseconds from --timeout. Defaults to 5000; individual
		 * test APIs can select a different timeout.
		 */
		readonly timeoutMs: number;
		/**
		 * Resolved positive shuffle seed, or null when shuffling is disabled. --shuffle
		 * without a seed chooses it once before compilation; the same seed drives execution
		 * and cache identity.
		 */
		readonly shuffleSeed: number | null;
	};

	/**
	 * Resolved engine policies. These describe build inputs, never post-DCE native
	 * feature inclusion.
	 */
	export type ExecutionEngineConfig = {
		/**
		 * Requested primordial mutation policy. Defaults to locked. The execution snapshot
		 * itself is immutable in either policy.
		 */
		readonly primordials: "locked" | "mutable";
		/**
		 * Dynamic compilation policy. false (default) rejects eval/Function execution at
		 * runtime; true enables the runtime compiler; compile-check additionally rejects
		 * statically visible dynamic compilation calls.
		 */
		readonly eval: boolean | "compile-check";
		/**
		 * Whether additional realms are enabled. Defaults to false.
		 */
		readonly realms: boolean;
		/**
		 * Whether regular expressions are enabled. Defaults to true.
		 */
		readonly regexp: boolean;
		/**
		 * Whether Temporal and its required data are enabled. Defaults to false.
		 */
		readonly temporal: boolean;
		/**
		 * Requested Intl policy after applying configuration defaults.
		 */
		readonly intl: {
			/**
			 * Whether Intl is enabled. Defaults to false.
			 */
			readonly enabled: boolean;
			/**
			 * Requested Intl service names. An empty array selects the default complete
			 * service set when Intl is enabled; it does not mean every service survived tree
			 * shaking.
			 */
			readonly features: ReadonlyArray<string>;
			/**
			 * Requested locale selection. Defaults to an empty array. Unsupported locale
			 * selections are rejected by configuration validation.
			 */
			readonly languages: ReadonlyArray<string>;
		};
	};

	/**
	 * Public application policies from the selected build configuration. Excludes
	 * build-host paths, asset declarations, output controls, and the obsolete Maligator
	 * surface switch.
	 */
	export type ExecutionConfig = {
		/**
		 * Engine configuration after validation and default resolution.
		 */
		readonly engine: ExecutionEngineConfig;
		/**
		 * Global and compatibility surface policy. maligator:process requires no enable
		 * flag.
		 */
		readonly surface: {
			/**
			 * Whether Web globals are requested. Defaults to false; native module imports are
			 * independent of this global installation policy.
			 */
			readonly webPlatform: boolean;
			/**
			 * Whether Node compatibility, globals, and node: module resolution are requested.
			 * Defaults to false.
			 */
			readonly node: boolean;
		};
		/**
		 * Resolved module-resolution policy.
		 */
		readonly modules: {
			/**
			 * Exact module-specifier replacements from configuration. Defaults to an empty
			 * object. Alias entries are immutable own data properties.
			 */
			readonly aliases: Readonly<Record<string, string>>;
		};
	};

	/**
	 * Fields shared by every execution workflow. All nested objects and arrays are
	 * deeply frozen at runtime.
	 */
	export type ExecutionCommon = {
		/**
		 * Explicit production application intent. True only when production was selected
		 * for the application; independent of NODE_ENV, profiling, and optimization.
		 * Currently --production is a build option. Defaults to false.
		 */
		readonly production: boolean;
		/**
		 * Whether the application image executes as native compiled code. A native
		 * executable hosting an interpreted image reports false. This is fixed for the
		 * image, not a query about the current stack frame or an eval-created function.
		 */
		readonly compiled: boolean;
		/**
		 * Actual selected frontend optimization policy. Ordinary commands currently use
		 * development; production builds and profiling use full. Backend choice is
		 * independent.
		 */
		readonly optimization: "development" | "full";
		/**
		 * Resolved application target. The compiler's host platform is not substituted
		 * during a cross build.
		 */
		readonly target: ExecutionTarget;
		/**
		 * Validated configuration policies with defaults applied, captured before
		 * compilation.
		 */
		readonly config: ExecutionConfig;
	};

	/**
	 * An immutable application-image description, discriminated by command. The command
	 * describes the workflow that prepared the image, not a transient process phase.
	 */
	export type Execution = ExecutionCommon &
		(
			| {
					/**
					 * Prepared by maligator build. Remains build when the resulting executable runs
					 * later; application statements are not executed by the build itself.
					 */
					readonly command: "build";
					/**
					 * Normalized build options relevant to application execution.
					 */
					readonly options: ExecutionOptions;
			  }
			| {
					/**
					 * Prepared by maligator run or maligator dev. dev denotes the watch/restart
					 * workflow even when profiling selects native compilation.
					 */
					readonly command: "run" | "dev";
					/**
					 * Normalized run/dev options. Arguments after -- remain runtime argv and do not
					 * specialize application compilation.
					 */
					readonly options: ExecutionOptions;
			  }
			| {
					/**
					 * Prepared by maligator test. Preserved for interpreted tests, profiled native
					 * tests, and every fragment of the test application.
					 */
					readonly command: "test";
					/**
					 * Normalized test options. Narrow command to test before accessing test-only
					 * fields.
					 */
					readonly options: TestExecutionOptions;
			  }
		);

	/**
	 * The canonical execution description, fixed before application compilation. Reads
	 * of known own properties, import aliases and re-exports, immutable aliases and
	 * destructuring, primitive comparisons, boolean expressions, and if/switch branches
	 * specialize in development and full compilation. Dynamic keys and opaque calls
	 * remain ordinary JavaScript and may retain the runtime object. The snapshot has
	 * stable identity within an application context and deeply frozen own data
	 * properties; reflection sees the complete shape. Static and dynamic imports return
	 * the same export. A different command, option, configuration, target, or backend
	 * creates a different compilation context. Profiling does not change production
	 * intent. Importing the module does not keep unused native code alive.
	 *
	 * @example
	 * import { execution } from "maligator:process";
	 *
	 * if (execution.compiled && execution.production) {
	 *   console.log("native production application");
	 * }
	 *
	 * @example
	 * import { execution } from "maligator:process";
	 *
	 * if (execution.command === "test") {
	 *   console.log(execution.options.repeat);
	 * }
	 */
	export const execution: Execution;
}
