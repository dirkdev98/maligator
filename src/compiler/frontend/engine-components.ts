import type { ESTree } from "meriyah";
import type { WorldFacts } from "../shared/compiler-facts.ts";
import { staticMemberKey } from "./builtin-module-loads.ts";
import { traverseEstree } from "./estree-traversal.ts";
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
		...(features.temporalEnabled ? [TEMPORAL_INSTALLER] : []),
		...(features.intlEnabled
			? [INTL_INSTALLER, ...services.map(intlServiceInstaller)]
			: []),
	];
	if (installers.length === 0) return '#include "vm.h"\n';
	return `#include "language_components.h"\n\nconst MalHostInstaller mal_wire_language_components[] = {${installers.join(", ")}};\n`;
}

interface EngineComponentUses {
	temporal: boolean;
	intl: boolean;
	intlServices: Set<string>;
	allIntlServices: boolean;
}

/**
 * The language component installers an image retains: what the policy allows and
 * the program can reach. A relocatable image keeps every allowed component, since
 * the first image of a linked program installs the language for all later ones.
 */
export function engineComponentInstallers(
	program: SemanticProgram,
	world: WorldFacts,
	relocatable: boolean,
): Array<string> {
	const uses: EngineComponentUses =
		relocatable || world.eval === "runtime"
			? { temporal: true, intl: true, intlServices: new Set(), allIntlServices: true }
			: collectEngineComponentUses(program);
	const installers: Array<string> = [];
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

function collectEngineComponentUses(program: SemanticProgram): EngineComponentUses {
	const uses: EngineComponentUses = {
		temporal: false,
		intl: false,
		intlServices: new Set(),
		allIntlServices: false,
	};
	const unknownGlobal = () => {
		uses.temporal = true;
		uses.intl = true;
		uses.allIntlServices = true;
	};
	const unknownMember = () => {
		uses.temporal = true;
		uses.intl = true;
		for (const services of LOCALE_METHODS.values())
			for (const service of services) uses.intlServices.add(service);
	};
	const member = (key: string) => {
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
		traverseEstree(file.ast.body, (node, { parent }) => {
			if (node.type === "WithStatement") {
				unknownMember();
			} else if (node.type === "UnaryExpression" && node.operator === "typeof") {
				if (undeclared(node.argument, ["Intl", ...globalNames]))
					followed.add(node.argument);
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
			if (!binding.undeclared || binding.usageNodes.length === 0) continue;
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
