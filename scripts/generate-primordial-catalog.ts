import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	packPrimordialCatalog,
	mergePrimordialInventories,
	primordialInventoryDigest,
	primordialInstallerSourceInventory,
} from "./primordial-catalog-data.ts";
import { primordialInventoryModes } from "./primordial-inventory-config.ts";
import type { PrimordialInventoryPhase } from "./primordial-inventory-data.ts";

const directory = path.resolve(process.argv[2] ?? ".cache/primordial-inventory");
const phases = JSON.parse(
	readFileSync(path.join(directory, "inventory-full.json"), "utf8"),
) as Array<PrimordialInventoryPhase>;
const language = phases.find((phase) => phase.phase === "language-initialized");
const installed = phases.find((phase) => phase.phase === "host-installed");
if (language === undefined || installed === undefined)
	throw new Error("Both installation phases are required");
const matrix = [
	"full",
	...primordialInventoryModes.filter((mode) => mode !== "full"),
].map((mode) => ({
	mode,
	phases: JSON.parse(
		readFileSync(path.join(directory, `inventory-${mode}.json`), "utf8"),
	) as Array<PrimordialInventoryPhase>,
}));
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
const fixtureDirectory = "tests/fixtures/primordial-inventory";
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
		platform: process.platform,
		arch: process.arch,
		modes: matrix.map(({ mode, phases }) => ({
			mode,
			sha256: primordialInventoryDigest(phases),
			phases: phases.map((phase) => ({
				phase: phase.phase,
				nodes: phase.nodes.length,
				descriptors: phase.nodes.reduce((sum, node) => sum + node.descriptors.length, 0),
				repeatedOwnKeys: phase.repeatedOwnKeys,
			})),
		})),
		availability: catalog.nodes.flatMap((node) =>
			node[4].map((property) => {
				const key =
					typeof property[0] === "string"
						? { string: property[0] }
						: { symbol: catalog.nodes[property[0][0]]![0] };
				return [
					node[0],
					key,
					matrix
						.filter(({ phases }) =>
							phases.some(
								(phase) =>
									phase.phase === "host-installed" &&
									phase.nodes.some(
										(candidate) =>
											candidate.id === node[0] &&
											candidate.descriptors.some(
												(descriptor) =>
													JSON.stringify(descriptor.key) === JSON.stringify(key),
											),
									),
							),
						)
						.map(({ mode }) => mode),
				];
			}),
		),
	})}\n`,
);
