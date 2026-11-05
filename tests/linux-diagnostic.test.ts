import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
	readFileSync(
		path.resolve(import.meta.dirname, "../.github/workflows/linux-diagnostic.yml"),
		"utf8",
	),
) as { jobs: { diagnostic: { steps: Array<{ id?: string; run?: string }> } } };
const bundleStep = workflow.jobs.diagnostic.steps.find((step) => step.id === "bundle");
if (bundleStep?.run === undefined)
	throw new Error("Diagnostic bundle entry point is missing");
const unpack = bundleStep.run;

const fixture = `
import base64, hashlib, io, json, sys, tarfile
from pathlib import Path
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
    for entry in json.loads(sys.argv[1]):
        item = tarfile.TarInfo(entry["name"])
        if entry.get("symlink"):
            item.type = tarfile.SYMTYPE
            item.linkname = entry["symlink"]
            archive.addfile(item)
        else:
            data = entry.get("text", "").encode()
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
packed = buffer.getvalue()
event = {"inputs": {"bundle": base64.b64encode(packed).decode(),
    "sha256": "0" * 64 if sys.argv[2] == "bad-digest" else hashlib.sha256(packed).hexdigest()}}
event_path = Path("event.json").absolute()
event_path.write_text(json.dumps(event))
`;

function withBundle(
	entries: Array<{ name: string; text?: string; symlink?: string }>,
	check: (result: ReturnType<typeof spawnSync>, root: string) => void,
	badDigest = false,
): void {
	const root = mkdtempSync(path.join(tmpdir(), "mal-linux-diagnostic-"));
	try {
		const prepared = spawnSync(
			"python3",
			["-c", fixture, JSON.stringify(entries), badDigest ? "bad-digest" : "valid"],
			{ cwd: root, encoding: "utf8", timeout: 10_000 },
		);
		if (prepared.error !== undefined) throw prepared.error;
		if (prepared.status !== 0) throw new Error(String(prepared.stderr));
		const result = spawnSync(
			"bash",
			["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", unpack],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 10_000,
				env: { ...process.env, GITHUB_EVENT_PATH: path.join(root, "event.json") },
			},
		);
		if (result.error !== undefined) throw result.error;
		check(result, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

it("unpacks the pinned diagnostic and records its input files", () => {
	const entries = [
		{ name: "run.sh", text: "exit 0\n" },
		{ name: "inputs/example.txt", text: "fictional input\n" },
	];
	withBundle(entries, (result, root) => {
		expect(result.status, String(result.stderr)).toBe(0);
		for (const entry of entries)
			expect(
				readFileSync(
					path.join(root, ".cache/linux-diagnostic/payload", entry.name),
					"utf8",
				),
			).toBe(entry.text);
		const manifest = JSON.parse(
			readFileSync(path.join(root, ".cache/linux-diagnostic/manifest.json"), "utf8"),
		) as { files: Array<{ path: string; sha256: string }> };
		expect(manifest.files.map((file) => file.path).sort()).toEqual(
			entries.map((entry) => entry.name).sort(),
		);
	});
});

it("rejects a diagnostic whose archive does not match its pinned digest", () => {
	withBundle(
		[{ name: "run.sh", text: "exit 0\n" }],
		(result, root) => {
			expect(result.status).not.toBe(0);
			expect(String(result.stderr)).toContain("Diagnostic bundle digest mismatch");
			expect(existsSync(path.join(root, ".cache/linux-diagnostic/payload"))).toBe(false);
		},
		true,
	);
});

it.each(["../outside.sh", "/outside.sh"])(
	"rejects the diagnostic path %s before extraction",
	(name) => {
		withBundle([{ name, text: "exit 0\n" }], (result) => {
			expect(result.status).not.toBe(0);
			expect(String(result.stderr)).toContain("paths must stay inside the payload");
		});
	},
);

it("rejects links in a diagnostic bundle", () => {
	withBundle([{ name: "run.sh", symlink: "../outside.sh" }], (result) => {
		expect(result.status).not.toBe(0);
		expect(String(result.stderr)).toContain("only regular files and directories");
	});
});

it("rejects a diagnostic without its shell entry point", () => {
	withBundle([{ name: "notes.txt", text: "fictional input\n" }], (result) => {
		expect(result.status).not.toBe(0);
		expect(String(result.stderr)).toContain("requires run.sh");
	});
});
