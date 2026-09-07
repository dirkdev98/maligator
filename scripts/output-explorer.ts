import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WIRE_MAGIC, WIRE_VERSION } from "../src/compiler/target/program-image-codec.ts";
import {
	compileExplorerCore,
	compileMode,
	stableJson,
	stableValue,
} from "../src/explorer/compiler.ts";
import { SAMPLES } from "../src/explorer/samples.ts";
import type { Sample, StageId, ViewId } from "../src/explorer/samples.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT_ROOT = path.join(ROOT, ".cache", "output-explorer");
const TEMPLATE_PATH = path.join(ROOT, "scripts", "output-explorer-page.html");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const MASCOT_PATH = path.join(ROOT, "website", "mascot.webp");

function stageOutput(result: ReturnType<typeof compileMode>, stage: StageId): string {
	switch (stage) {
		case "preCore":
			return result.preCore;
		case "optimizedCore":
			return result.optimizedCore;
		case "target":
			return result.target;
		case "malw":
			return result.malw;
		case "c":
			return result.c;
	}
}

function validateTrails(
	sample: Sample,
	generic: ReturnType<typeof compileMode>,
	full: ReturnType<typeof compileMode>,
): void {
	for (const trail of sample.trails) {
		for (const [stage, query] of Object.entries(trail.queries) as Array<
			[ViewId, string]
		>) {
			const outputs =
				stage === "source"
					? [sample.source]
					: stage === "optimizedCore"
						? [generic.optimizedCore, full.optimizedCore]
						: [stageOutput(full, stage)];
			const present = outputs.every((output) =>
				output.toLowerCase().includes(query.toLowerCase()),
			);
			if (!present) {
				throw new Error(
					`${sample.id}: trail '${trail.title}' cannot find '${query}' in ${stage}`,
				);
			}
		}
	}
}

function sha256(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function gitOutput(args: ReadonlyArray<string>): string {
	try {
		return execFileSync("git", [...args], {
			cwd: ROOT,
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown";
	}
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as {
	version: string;
};
const commit = gitOutput(["rev-parse", "--short=12", "HEAD"]);
const dirty = gitOutput(["status", "--porcelain"]) !== "";
const snapshotId = safeSegment(
	`${packageJson.version}-${commit}${dirty ? "-dirty" : ""}`,
);
const snapshotRoot = path.join(OUTPUT_ROOT, "artifacts", snapshotId);
rmSync(snapshotRoot, { recursive: true, force: true });
mkdirSync(snapshotRoot, { recursive: true });

const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
function writeArtifact(relativePath: string, content: string | Uint8Array): string {
	const destination = path.join(snapshotRoot, relativePath);
	mkdirSync(path.dirname(destination), { recursive: true });
	writeFileSync(destination, content);
	const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.length;
	manifestFiles.push({ path: relativePath, bytes, sha256: sha256(content) });
	return path.posix.join("artifacts", snapshotId, relativePath.split(path.sep).join("/"));
}

const samples = SAMPLES.map((sample) => {
	const compiled = compileExplorerCore(sample.source, sample.config ?? {});
	const full = compileMode(compiled, "full");
	const generic = compileMode(compiled, "generic");
	validateTrails(sample, generic, full);
	const base = sample.id;
	const sourcePath = writeArtifact(path.join(base, "source.ts"), `${sample.source}\n`);
	const preCorePath = writeArtifact(path.join(base, "pre-core.txt"), `${full.preCore}\n`);
	const modeData = Object.fromEntries(
		(["generic", "full"] as const).map((mode) => {
			const result = mode === "full" ? full : generic;
			const prefix = path.join(base, mode);
			const artifacts = {
				optimizedCore: writeArtifact(
					path.join(prefix, "optimized-core.txt"),
					`${result.optimizedCore}\n`,
				),
				target: writeArtifact(path.join(prefix, "target.txt"), `${result.target}\n`),
				malwDecoded: writeArtifact(
					path.join(prefix, "malw-decoded.txt"),
					`${result.malw}\n`,
				),
				malwHex: writeArtifact(path.join(prefix, "malw.hex.txt"), `${result.hex}\n`),
				malw: writeArtifact(path.join(prefix, "program.malw"), result.wire),
				c: writeArtifact(path.join(prefix, "program.c"), `${result.c}\n`),
				trace: writeArtifact(
					path.join(prefix, "optimization-trace.json"),
					`${stableJson(result.trace)}\n`,
				),
			};
			return [
				mode,
				{
					label:
						mode === "full"
							? "Selected late-specialization plan"
							: "Canonical Core · generic target",
					optimizedCore: result.optimizedCore,
					target: result.target,
					malw: result.malw,
					hex: result.hex,
					c: result.c,
					wireBase64: Buffer.from(result.wire).toString("base64"),
					trace: stableValue(result.trace),
					structure: result.structure,
					stats: result.stats,
					artifacts,
				},
			];
		}),
	);
	return {
		...sample,
		preCore: full.preCore,
		artifacts: { source: sourcePath, preCore: preCorePath },
		modes: modeData,
	};
});

const manifest = {
	schema: 1,
	snapshot: {
		id: snapshotId,
		maligatorVersion: packageJson.version,
		commit,
		dirty,
		wire: {
			magic: `0x${WIRE_MAGIC.toString(16).padStart(8, "0")}`,
			ascii: "MALW",
			version: WIRE_VERSION,
		},
		optimizationModes: {
			generic: { profile: "canonical-generic-target" },
			full: { profile: "selected-late-plan" },
		},
	},
	files: manifestFiles.sort((left, right) => left.path.localeCompare(right.path)),
};
writeFileSync(path.join(snapshotRoot, "manifest.json"), `${stableJson(manifest)}\n`);

const pageData = {
	manifest: { snapshot: manifest.snapshot },
	samples: samples.map((sample) => {
		const generic = sample.modes.generic;
		const full = sample.modes.full;
		if (generic === undefined || full === undefined) {
			throw new Error(`${sample.id}: missing output mode`);
		}
		return {
			id: sample.id,
			group: sample.group,
			title: sample.title,
			summary: sample.summary,
			source: sample.source,
			trails: sample.trails,
			preCore: sample.preCore,
			modes: {
				generic: { optimizedCore: generic.optimizedCore },
				full: {
					optimizedCore: full.optimizedCore,
					target: full.target,
					malw: full.malw,
					c: full.c,
				},
			},
		};
	}),
};

const template = readFileSync(TEMPLATE_PATH, "utf8");
const dataMarker = "__MALIGATOR_OUTPUT_EXPLORER_DATA__";
const mascotMarker = "__MALIGATOR_NAV_MASCOT__";
for (const marker of [dataMarker, mascotMarker]) {
	if (!template.includes(marker)) throw new Error(`missing ${marker} in page template`);
}
const html = template
	.replace(dataMarker, JSON.stringify(pageData).replaceAll("</script", "<\\/script"))
	.replace(mascotMarker, readFileSync(MASCOT_PATH).toString("base64"));
mkdirSync(OUTPUT_ROOT, { recursive: true });
writeFileSync(path.join(OUTPUT_ROOT, "index.html"), html);

console.log(path.join(OUTPUT_ROOT, "index.html"));
console.log(path.join(snapshotRoot, "manifest.json"));
