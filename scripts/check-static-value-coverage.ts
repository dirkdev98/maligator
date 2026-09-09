import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import {
	summarizeStaticValueCoverage,
	validateStaticValueCoverage,
} from "./static-value-coverage.ts";
import type { StaticValueCoverage } from "./static-value-coverage.ts";

const { values } = parseArgs({
	options: {
		task: { type: "string", multiple: true },
		wave: { type: "string" },
		closure: { type: "boolean", default: false },
		out: { type: "string", default: ".cache/static-value-coverage/report.json" },
	},
});
const coverage = JSON.parse(
	readFileSync("tests/fixtures/primordial-inventory/coverage.json", "utf8"),
) as StaticValueCoverage;
if (values.wave !== undefined && !/^[C-N]$/.test(values.wave))
	throw new Error("--wave must name C through N");
const tasks =
	values.task === undefined && values.wave === undefined
		? undefined
		: [
				...new Set([
					...(values.task ?? []),
					...(values.wave === undefined
						? []
						: coverage.rows
								.filter((row) => row.task.startsWith(`${values.wave}-`))
								.map((row) => row.task)),
				]),
			];
const sources = new Map<string, string>();
function contains(file: string, text: string) {
	if (!existsSync(file)) return false;
	let source = sources.get(file);
	if (source === undefined) {
		source = readFileSync(file, "utf8");
		sources.set(file, source);
	}
	return source.includes(text);
}
const evidence = {
	tasks,
	witnessExists: (witness: { file: string; test: string; case?: string }) =>
		contains(witness.file, witness.test) &&
		(witness.case === undefined || contains(witness.file, JSON.stringify(witness.case))),
	implementationExists: (implementation: { file: string; symbol: string }) =>
		contains(implementation.file, implementation.symbol),
};
const catalog = getPrimordialCatalog();
validateStaticValueCoverage(coverage, catalog, evidence);
const summary = summarizeStaticValueCoverage(coverage, tasks);
let closureFailure: string | undefined;
if (values.closure) {
	try {
		validateStaticValueCoverage(coverage, catalog, { ...evidence, closure: true });
	} catch (error) {
		closureFailure = error instanceof Error ? error.message : String(error);
	}
}
const output = values.out;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
	output,
	`${JSON.stringify({ schema: 1, scope: tasks ?? "all", summary, closure: values.closure ? closureFailure === undefined : null, closureFailure }, null, 2)}\n`,
);
for (const row of summary)
	console.log(
		`${row.task}: ${row.implemented} implemented, ${row.notApplicable} inapplicable, ${row.pending} pending cells, ${row.unreconciledSeeds} unreconciled seeds`,
	);
console.log(`Coverage report: ${output}`);
if (closureFailure !== undefined) {
	console.error(closureFailure);
	process.exitCode = 1;
}
