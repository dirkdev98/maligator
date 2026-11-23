import type { ESTree } from "meriyah";
import { compilerFactIsWorldInvariant } from "../shared/compiler-facts.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import { BUILTIN_MEMBER_GROUPS } from "./builtin-member-data.ts";
import { staticMemberKey } from "./builtin-module-loads.ts";
import { ESTREE_STOP, traverseEstree } from "./estree-traversal.ts";
import { REGEXP_INSTALLER } from "./host-modules.ts";
import type { SemanticProgram } from "./semantic-analysis.ts";

/*
 * Temporal and the Intl services are language components: every runtime archive
 * contains them, and an image links one only when its installer is in the image's
 * host manifest. The engine policy decides which components may exist; a program
 * retains the allowed ones it can reach. Runtime eval and a global object handed to
 * unknown code can reach any global, and an unknown member key can reach the
 * locale-sensitive methods on every prototype.
 */

export const TEMPORAL_INSTALLER = "mal_host_install_temporal";
export const INTL_INSTALLER = "mal_host_install_intl";
export const DATE_INSTALLER = "mal_host_install_intrinsic_date";
export const BIGINT_INSTALLER = "mal_host_install_intrinsic_bigint";
export const MAP_INSTALLER = "mal_host_install_intrinsic_map";
export const SET_INSTALLER = "mal_host_install_intrinsic_set";
export const JSON_INSTALLER = "mal_host_install_intrinsic_json";
export const DISPOSABLE_STACK_INSTALLER = "mal_host_install_intrinsic_disposable_stack";

export const INTRINSIC_FAMILIES: ReadonlyMap<string, string> = new Map([
	["BigInt", BIGINT_INSTALLER],
	["BigInt64Array", BIGINT_INSTALLER],
	["BigUint64Array", BIGINT_INSTALLER],
	["Map", MAP_INSTALLER],
	["WeakMap", MAP_INSTALLER],
	["Set", SET_INSTALLER],
	["WeakSet", SET_INSTALLER],
	["WeakRef", "mal_host_install_intrinsic_weak_ref"],
	["FinalizationRegistry", "mal_host_install_intrinsic_finalization_registry"],
	["DisposableStack", DISPOSABLE_STACK_INSTALLER],
	["AsyncDisposableStack", DISPOSABLE_STACK_INSTALLER],
	["Math", "mal_host_install_intrinsic_math"],
	["JSON", JSON_INSTALLER],
	["Atomics", "mal_host_install_intrinsic_atomics"],
	["Proxy", "mal_host_install_intrinsic_proxy"],
	["Date", DATE_INSTALLER],
]);
export const INTRINSIC_INSTALLERS = [...new Set(INTRINSIC_FAMILIES.values())];

const BIGINT_MEMORY_MEMBERS = new Set([
	"getBigInt64",
	"getBigUint64",
	"setBigInt64",
	"setBigUint64",
	...["read", "write"].flatMap((op) =>
		["BigInt64", "BigUInt64", "BigUint64"].flatMap((kind) => [
			`${op}${kind}LE`,
			`${op}${kind}BE`,
		]),
	),
]);

/** Intl service constructors by their engine.intl.features names. */
const INTL_SERVICES = new Map([
	["Collator", "collator"],
	["PluralRules", "plural-rules"],
	["NumberFormat", "number-format"],
	["DateTimeFormat", "date-time-format"],
	["ListFormat", "list-format"],
	["DisplayNames", "display-names"],
	["RelativeTimeFormat", "relative-time-format"],
	["Segmenter", "segmenter"],
	["DurationFormat", "duration-format"],
]);

/** Locale-sensitive methods outside Intl, with the services behind them. */
const LOCALE_METHODS = new Map<string, ReadonlyArray<string>>([
	["localeCompare", ["collator"]],
	["toLocaleString", ["number-format", "date-time-format"]],
	["toLocaleDateString", ["date-time-format"]],
	["toLocaleTimeString", ["date-time-format"]],
	// Case mapping canonicalizes its locale list with the Intl namespace.
	["toLocaleUpperCase", []],
	["toLocaleLowerCase", []],
]);

/** Members that hand a property to code the compiler cannot follow. */
const REFLECTIVE_MEMBERS = new Set([
	"Reflect",
	"getOwnPropertyDescriptor",
	"getOwnPropertyDescriptors",
]);

const BUILTIN_MEMBER_OBSERVERS = new Set([
	...REFLECTIVE_MEMBERS,
	"Proxy",
	"assign",
	"defineProperties",
	"defineProperty",
	"entries",
	"getOwnPropertyNames",
	"getOwnPropertySymbols",
	"hasOwn",
	"hasOwnProperty",
	"keys",
	"ownKeys",
	"propertyIsEnumerable",
	"values",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);

const INSTALLED_MEMBER_NAMES = new Set<string>(
	BUILTIN_MEMBER_GROUPS.flatMap(({ members }) => members.map(([, key]) => key)),
);
const SIMPLE_CONSOLE_METHODS = new Set(["debug", "error", "info", "log", "warn"]);

/** A closed source can ask for named builtin properties. Reflective reads keep the descriptor graph. */
export function builtinMemberNames(
	program: SemanticProgram,
	facts: CompilerProgramFacts,
	relocatable: boolean,
): Array<string> | undefined {
	if (
		relocatable ||
		facts.world.primordialPolicy !== "locked" ||
		facts.world.eval !== "disabled" ||
		facts.world.realms ||
		facts.closure.sourceClosure.kind !== "known"
	) {
		return undefined;
	}
	const names = new Set<string>();
	for (const file of program.files) {
		if (
			!file.strict ||
			file.scopes[0]?.bindings.some(
				(binding) =>
					binding.undeclared &&
					binding.usageNodes.length > 0 &&
					["global", "globalThis", "Reflect", "Proxy"].includes(binding.name),
			)
		) {
			return undefined;
		}
		const knownKey = (node: ESTree.Node) =>
			(node.type === "Literal" && !("regex" in node)) ||
			(node.type === "MemberExpression" &&
				node.object.type === "Identifier" &&
				node.object.name === "Symbol" &&
				file.nodeToBinding.get(node.object)?.undeclared === true &&
				staticMemberKey(node) !== undefined &&
				WELL_KNOWN_SYMBOLS.has(staticMemberKey(node)!));
		const consoleBinding = file.scopes[0]?.bindings.find(
			(binding) => binding.undeclared && binding.name === "console",
		);
		const consoleCalls = new Set<ESTree.Node>();
		const opaque = traverseEstree(file.ast.body, (node, { parent }) => {
			if (
				consoleBinding !== undefined &&
				node.type === "CallExpression" &&
				node.arguments.length === 1 &&
				node.arguments[0]!.type !== "SpreadElement" &&
				node.callee.type === "MemberExpression" &&
				node.callee.object.type === "Identifier" &&
				file.nodeToBinding.get(node.callee.object) === consoleBinding &&
				SIMPLE_CONSOLE_METHODS.has(staticMemberKey(node.callee) ?? "")
			) {
				consoleCalls.add(node.callee.object);
			}
			if (
				node.type === "ForInStatement" ||
				node.type === "WithStatement" ||
				(node.type === "RestElement" && parent?.type === "ObjectPattern") ||
				(node.type === "SpreadElement" &&
					parent?.type === "ObjectExpression" &&
					node.argument.type !== "ObjectExpression" &&
					!(
						node.argument.type === "ConditionalExpression" &&
						node.argument.consequent.type === "ObjectExpression" &&
						node.argument.alternate.type === "ObjectExpression"
					)) ||
				(node.type === "BinaryExpression" &&
					node.operator === "in" &&
					!knownKey(node.left))
			) {
				return ESTREE_STOP;
			}
			if (node.type === "Literal" && typeof node.value === "string")
				names.add(node.value);
			if (node.type === "MemberExpression") {
				const key = staticMemberKey(node);
				if (key === undefined) {
					if (node.computed && !knownKey(node.property)) return ESTREE_STOP;
				} else {
					if (BUILTIN_MEMBER_OBSERVERS.has(key)) return ESTREE_STOP;
					// A replacer list can read properties outside enumerable own keys.
					if (
						key === "stringify" &&
						(parent?.type !== "CallExpression" ||
							parent.callee !== node ||
							parent.arguments.length > 1 ||
							parent.arguments[0]?.type === "SpreadElement")
					)
						return ESTREE_STOP;
					names.add(key);
				}
			}
			if (node.type === "Property" && parent?.type === "ObjectPattern") {
				if (node.computed && !knownKey(node.key)) return ESTREE_STOP;
				const key =
					!node.computed && node.key.type === "Identifier"
						? node.key.name
						: node.key.type === "Literal" && typeof node.key.value === "string"
							? node.key.value
							: undefined;
				if (key !== undefined) {
					if (BUILTIN_MEMBER_OBSERVERS.has(key) || key === "stringify")
						return ESTREE_STOP;
					names.add(key);
				}
			}
		});
		if (
			opaque === ESTREE_STOP ||
			consoleBinding?.usageNodes.some((use) => !consoleCalls.has(use))
		)
			return undefined;
	}
	return [...names].filter((name) => INSTALLED_MEMBER_NAMES.has(name)).sort();
}

const WELL_KNOWN_SYMBOLS = new Set([
	"asyncDispose",
	"asyncIterator",
	"dispose",
	"hasInstance",
	"isConcatSpreadable",
	"iterator",
	"match",
	"matchAll",
	"replace",
	"search",
	"species",
	"split",
	"toPrimitive",
	"toStringTag",
	"unscopables",
]);

export function intlServiceInstaller(service: string): string {
	return `${INTL_INSTALLER}_${service.replaceAll("-", "_")}`;
}

/**
 * C for a driver that loads wire images built under these native features. It names
 * every component such an image may list, so the driver links and registers each one;
 * a component it does not link cannot resolve.
 */
export function languageComponentAnchorSource(features: {
	readonly intlEnabled: boolean;
	readonly intlFeatures: ReadonlyArray<string>;
	readonly temporalEnabled: boolean;
}): string {
	const services = [...INTL_SERVICES.values()].filter(
		(service) =>
			features.intlFeatures.length === 0 ||
			features.intlFeatures.includes(`intl-${service}`),
	);
	const installers = [
		...INTRINSIC_INSTALLERS,
		...(features.temporalEnabled ? [TEMPORAL_INSTALLER] : []),
		...(features.intlEnabled
			? [INTL_INSTALLER, ...services.map(intlServiceInstaller)]
			: []),
	];
	return `#include "language_components.h"\n\nconst MalHostInstaller mal_wire_language_components[] = {${installers.join(", ")}};\n`;
}

interface EngineComponentUses {
	temporal: boolean;
	intl: boolean;
	intlServices: Set<string>;
	allIntlServices: boolean;
	intrinsicInstallers: Set<string>;
	allIntrinsicInstallers: boolean;
}

/**
 * The language component installers an image retains: what the policy allows and
 * the program can reach. A relocatable image keeps every allowed component, since
 * the first image of a linked program installs the language for all later ones.
 */
export function engineComponentInstallers(
	program: SemanticProgram,
	facts: CompilerProgramFacts,
	relocatable: boolean,
	globalObjectReads: ReadonlyMap<ESTree.Identifier, string | null>,
): Array<string> {
	const { world } = facts;
	const uses: EngineComponentUses =
		relocatable || world.eval === "runtime"
			? {
					temporal: true,
					intl: true,
					intlServices: new Set(),
					allIntlServices: true,
					intrinsicInstallers: new Set(),
					allIntrinsicInstallers: true,
				}
			: collectEngineComponentUses(program, facts, globalObjectReads);
	const installers = [
		...(uses.allIntrinsicInstallers ? INTRINSIC_INSTALLERS : uses.intrinsicInstallers),
	];
	if (uses.allIntrinsicInstallers && world.ecmaFeatures.regexp)
		installers.push(REGEXP_INSTALLER);
	if (world.ecmaFeatures.temporal && uses.temporal) installers.push(TEMPORAL_INSTALLER);
	if (!world.ecmaFeatures.intl) return installers;
	const selected = world.ecmaFeatures.intlServices ?? [];
	const services = [...INTL_SERVICES.values()].filter(
		(service) =>
			(selected.length === 0 || selected.includes(service)) &&
			(uses.allIntlServices || uses.intlServices.has(service)),
	);
	if (uses.intl || services.length > 0) installers.push(INTL_INSTALLER);
	for (const service of services) installers.push(intlServiceInstaller(service));
	return installers;
}

function collectEngineComponentUses(
	program: SemanticProgram,
	facts: CompilerProgramFacts,
	globalObjectReads: ReadonlyMap<ESTree.Identifier, string | null>,
): EngineComponentUses {
	const uses: EngineComponentUses = {
		temporal: false,
		intl: false,
		intlServices: new Set(),
		allIntlServices: false,
		intrinsicInstallers: new Set(),
		allIntrinsicInstallers:
			facts.world.primordialPolicy !== "locked" ||
			facts.world.eval !== "disabled" ||
			facts.world.realms ||
			facts.closure.sourceClosure.kind !== "known",
	};
	const intrinsicGlobal = (name: string) => {
		const installer = INTRINSIC_FAMILIES.get(name);
		if (installer !== undefined) uses.intrinsicInstallers.add(installer);
	};
	const namedGlobalRead = (name: string | undefined) => {
		// A read of an ambient property could dispatch an accessor with the global
		// object as receiver. The locked language bindings have fixed descriptors.
		if (
			name === undefined ||
			name === "globalThis" ||
			name === "global" ||
			!compilerFactIsWorldInvariant(facts.immutableGlobalBindings.get(name))
		)
			uses.allIntrinsicInstallers = true;
		else intrinsicGlobal(name);
	};
	const unknownGlobal = () => {
		uses.temporal = true;
		uses.intl = true;
		uses.allIntlServices = true;
	};
	const unknownMember = () => {
		uses.intrinsicInstallers.add(BIGINT_INSTALLER);
		uses.temporal = true;
		uses.intl = true;
		for (const services of LOCALE_METHODS.values())
			for (const service of services) uses.intlServices.add(service);
	};
	const member = (key: string) => {
		if (BIGINT_MEMORY_MEMBERS.has(key)) uses.intrinsicInstallers.add(BIGINT_INSTALLER);
		if (key === "Intl") {
			uses.intl = true;
			uses.allIntlServices = true;
		} else if (key === "Temporal" || key === "toTemporalInstant") {
			uses.temporal = true;
		} else if (REFLECTIVE_MEMBERS.has(key)) {
			unknownMember();
		} else {
			const services = LOCALE_METHODS.get(key);
			if (services === undefined) return;
			uses.intl = true;
			for (const service of services) uses.intlServices.add(service);
		}
	};
	const globalNames = ["globalThis", "global"];

	for (const file of program.files) {
		const undeclared = (node: ESTree.Node, names: ReadonlyArray<string>) => {
			if (node.type !== "Identifier") return false;
			const binding = file.nodeToBinding.get(node);
			return binding?.undeclared === true && names.includes(binding.name);
		};
		// Reads of `Intl` and the global object that observe one named property.
		const followed = new Set<ESTree.Node>();
		const followedOptional = new Set<ESTree.Node>();
		traverseEstree(file.ast.body, (node, { parent }) => {
			if (node.type === "WithStatement") {
				unknownMember();
				uses.allIntrinsicInstallers = true;
			} else if (node.type === "ThisExpression" && !uses.allIntrinsicInstallers) {
				let scope = file.nodeToScope.get(node);
				while (
					scope !== undefined &&
					scope.node.type !== "Program" &&
					scope.node.type !== "FunctionDeclaration" &&
					scope.node.type !== "FunctionExpression" &&
					scope.node.type !== "PropertyDefinition" &&
					scope.node.type !== "StaticBlock"
				)
					scope = scope.parent ?? undefined;
				if (scope?.node.type === "Program") {
					if (file.type === "script" && !file.commonjs)
						uses.allIntrinsicInstallers = true;
				} else if (scope !== undefined && !scope.strict) {
					uses.allIntrinsicInstallers = true;
				}
			} else if (node.type === "UnaryExpression" && node.operator === "typeof") {
				if (undeclared(node.argument, ["Intl", ...globalNames]))
					followed.add(node.argument);
				if (undeclared(node.argument, globalNames)) followedOptional.add(node.argument);
			} else if (
				node.type === "BinaryExpression" &&
				(node.operator === "===" || node.operator === "!==")
			) {
				if (undeclared(node.left, globalNames)) followedOptional.add(node.left);
				if (undeclared(node.right, globalNames)) followedOptional.add(node.right);
			} else if (node.type === "MemberExpression") {
				const key = staticMemberKey(node);
				if (key !== undefined) member(key);
				else if (node.property.type !== "Literal" || "regex" in node.property)
					unknownMember();
				if (undeclared(node.object, ["Intl"])) {
					followed.add(node.object);
					const service = key === undefined ? undefined : INTL_SERVICES.get(key);
					if (key === undefined) uses.allIntlServices = true;
					else if (service !== undefined) uses.intlServices.add(service);
				} else if (undeclared(node.object, globalNames)) {
					followed.add(node.object);
					followedOptional.add(node.object);
					namedGlobalRead(key);
					if (key === undefined) unknownGlobal();
				}
			} else if (node.type === "Property" && parent?.type === "ObjectPattern") {
				const key =
					!node.computed && node.key.type === "Identifier"
						? node.key.name
						: node.key.type === "Literal" && typeof node.key.value === "string"
							? node.key.value
							: undefined;
				if (key !== undefined) member(key);
				else if (node.computed) unknownMember();
			}
		});
		for (const binding of file.scopes[0]?.bindings ?? []) {
			// A declaration in the script global environment can observe an existing
			// global descriptor even when there is no free read of that name.
			if (file.type === "script" && !file.commonjs) intrinsicGlobal(binding.name);
			if (!binding.undeclared || binding.usageNodes.length === 0) continue;
			intrinsicGlobal(binding.name);
			if (!uses.allIntrinsicInstallers && globalNames.includes(binding.name)) {
				for (const use of binding.usageNodes) {
					if (followedOptional.has(use)) continue;
					namedGlobalRead(
						use.type === "Identifier"
							? (globalObjectReads.get(use) ?? undefined)
							: undefined,
					);
				}
			}
			if (binding.name === "Temporal") uses.temporal = true;
			else if (binding.name === "Reflect") unknownMember();
			else if (binding.name === "Intl") {
				uses.intl = true;
				if (binding.usageNodes.some((usage) => !followed.has(usage)))
					uses.allIntlServices = true;
			} else if (
				globalNames.includes(binding.name) &&
				binding.usageNodes.some((usage) => !followed.has(usage))
			)
				unknownGlobal();
		}
	}
	return uses;
}
