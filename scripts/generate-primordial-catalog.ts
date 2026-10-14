import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	packPrimordialCatalog,
	mergePrimordialInventories,
	primordialInstallerSourceInventory,
} from "./primordial-catalog-data.ts";
import {
	primordialInstallerFingerprint,
	primordialInventoryAudit,
	readPrimordialInventoryCaptures,
	readPrimordialInventoryConfigurations,
	requirePrimordialInventoryAudit,
	withPrimordialInventoryAudit,
} from "./primordial-inventory-audit.ts";
import { primordialInventoryModes } from "./primordial-inventory-config.ts";

const directory = path.resolve(process.argv[2] ?? ".cache/primordial-inventory");
const selection = process.argv[3];
if (selection !== undefined && !selection.startsWith("--modes="))
	throw new Error("Expected --modes=full,node or omit it to capture every mode");
const modes =
	selection === undefined
		? primordialInventoryModes
		: selection.slice("--modes=".length).split(",");
if (
	!modes.includes("full") ||
	new Set(modes).size !== modes.length ||
	modes.some((mode) => !primordialInventoryModes.includes(mode))
)
	throw new Error("Catalog inputs must include full and contain valid unique modes");
const matrix = readPrimordialInventoryCaptures(directory, [
	"full",
	...modes.filter((mode) => mode !== "full"),
]);
if (matrix[0]!.metadata.source.installerSha256 !== primordialInstallerFingerprint())
	throw new Error("Captured primordial installer inventory differs from current sources");
const phases = matrix[0]!.phases;
const language = phases.find((phase) => phase.phase === "language-initialized");
const installed = phases.find((phase) => phase.phase === "host-installed");
if (language === undefined || installed === undefined)
	throw new Error("Both installation phases are required");
JSON.parse(readFileSync(path.join(directory, "native-bindings.json"), "utf8"));
const catalog = packPrimordialCatalog(
	mergePrimordialInventories(
		matrix.map(({ phases }) => phases.find((phase) => phase.phase === "host-installed")!),
	),
);
const receivers = ["object", "array", "string", "number", "boolean", "bigint"];
const literalMethods = receivers.flatMap((receiver) => {
	const prototype = `MAL_INTRINSIC_${receiver.toUpperCase()}_PROTOTYPE`;
	const index = catalog.roots.find(([name]) => name === prototype)?.[1];
	if (typeof index !== "number") throw new Error(`Missing ${prototype}`);
	const node = catalog.nodes[index]!;
	return [...node[4]]
		.sort((a, b) => {
			const left = typeof a[0] === "string" ? a[0] : "";
			const right = typeof b[0] === "string" ? b[0] : "";
			return left < right ? -1 : left > right ? 1 : 0;
		})
		.flatMap((property) => {
			if (typeof property[2] !== "number" || (catalog.nodes[property[2]]![2] & 2) === 0)
				return [];
			const key =
				typeof property[0] === "string"
					? property[0]
					: catalog.nodes[property[0][0]]![0] === "%Symbol.iterator%"
						? null
						: undefined;
			return key === undefined
				? []
				: [[receiver, key, prototype, catalog.nodes[property[2]]![0], node[0]]];
		});
});
const fixtureDirectory = "tests/fixtures/primordial-inventory";
const previousConfigurations = readPrimordialInventoryConfigurations(
	`${fixtureDirectory}/configurations.json`,
);
const pendingModes = primordialInventoryModes.filter((mode) => !modes.includes(mode));
const audit = primordialInventoryAudit(matrix);
if (
	pendingModes.length > 0 &&
	(previousConfigurations.catalogTarget.platform !== audit.platform ||
		previousConfigurations.catalogTarget.arch !== audit.arch)
)
	throw new Error(
		"Partial capture inputs must share the historical platform and architecture",
	);
if (pendingModes.length > 0) {
	const previousAudit = requirePrimordialInventoryAudit(previousConfigurations, audit);
	audit.modes.push(...previousAudit.modes.filter(({ mode }) => !modes.includes(mode)));
	// The retained rows were captured separately and have no shared source identity.
	delete audit.source;
}
audit.modes.sort(
	(left, right) =>
		primordialInventoryModes.indexOf(left.mode) -
		primordialInventoryModes.indexOf(right.mode),
);
const output = "src/compiler/shared/primordial-catalog-data.ts";
writeFileSync(
	output,
	`import type { PrimordialCatalog } from "./primordial-catalog-types.ts";\n\n` +
		`// Regenerate from the native descriptor audit with scripts/generate-primordial-catalog.ts.\n` +
		`export const literalPrimordialBindings: ReadonlyArray<readonly [string, string | null, string, string, string]> = ${JSON.stringify(
			literalMethods,
		)};\n` +
		`let catalog: PrimordialCatalog | undefined;\n` +
		`export function getPrimordialCatalog(): PrimordialCatalog {\n` +
		`// A packed string keeps catalog data out of compiler IR and defers unused host metadata.\n` +
		`return catalog ??= JSON.parse(${JSON.stringify(
			JSON.stringify(catalog),
		)}) as PrimordialCatalog;\n}\n`,
);
const availability = new Map<string, Set<string>>();
for (const [owner, key, capturedModes] of previousConfigurations.availability) {
	availability.set(
		JSON.stringify([owner, key]),
		new Set(capturedModes.filter((mode) => pendingModes.includes(mode))),
	);
}
for (const { mode, phases } of matrix) {
	for (const phase of phases) {
		if (phase.phase !== "host-installed") continue;
		for (const node of phase.nodes) {
			for (const descriptor of node.descriptors) {
				const id = JSON.stringify([node.id, descriptor.key]);
				const availableModes = availability.get(id) ?? new Set<string>();
				availableModes.add(mode);
				availability.set(id, availableModes);
			}
		}
	}
}
// Fresh processes must read the newly written catalog, not an earlier cached module value.
execFileSync(process.execPath, ["scripts/generate-known-operations.ts"], {
	stdio: "inherit",
});
execFileSync(
	process.execPath,
	[
		"scripts/generate-known-native-entries.ts",
		path.join(directory, "native-bindings.json"),
	],
	{ stdio: "inherit" },
);
mkdirSync(fixtureDirectory, { recursive: true });
writeFileSync(
	`${fixtureDirectory}/installers.json`,
	`${JSON.stringify(primordialInstallerSourceInventory(), null, 2)}\n`,
);
writeFileSync(
	`${fixtureDirectory}/language.json`,
	`${JSON.stringify(packPrimordialCatalog(language))}\n`,
);
console.log(output);

writeFileSync(
	`${fixtureDirectory}/configurations.json`,
	`${JSON.stringify({
		...withPrimordialInventoryAudit(previousConfigurations, audit),
		catalogTarget: { platform: audit.platform, arch: audit.arch },
		pendingModes,
		pendingAvailability: pendingModes.length > 0 ? "last-captured" : undefined,
		availability: catalog.nodes.flatMap((node) =>
			node[4].map((property) => {
				const key =
					typeof property[0] === "string"
						? { string: property[0] }
						: { symbol: catalog.nodes[property[0][0]]![0] };
				return [
					node[0],
					key,
					primordialInventoryModes.filter((mode) =>
						availability.get(JSON.stringify([node[0], key]))?.has(mode),
					),
				];
			}),
		),
	})}\n`,
);
