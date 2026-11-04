import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, createWorkerUrl } from "maligator:workers";
import { restoreCompilerResult } from "../../../src/compiler-profile-result.ts";
import { createProfileCapture } from "../../../src/profile-artifact.ts";
import type { PreparedProfile } from "../../../src/profile-artifact.ts";
import type { produce, raw } from "./worker.mts";

type ProfileWorker = { produce: typeof produce; raw: typeof raw };

const quota = 64 * 1024;
const directory = mkdtempSync(join(tmpdir(), "mal-profile-result-"));
const pool = createPool(createWorkerUrl<ProfileWorker>("./worker.mts", import.meta.url), {
	size: 1,
	maxQueuedBytes: quota,
	maxMessageBytes: quota,
});
try {
	const handoff = join(directory, "handoff");
	mkdirSync(handoff);
	let inlineRejected = false;
	try {
		await pool.run("raw", []);
	} catch {
		inlineRejected = true;
	}
	if (!inlineRejected) throw new Error("inline profile did not exceed the message quota");
	const response = await pool.run("produce", [directory]);
	if (
		response.value.profileArtifact === undefined ||
		response.value.profileArtifact.bytes <= quota
	)
		throw new Error("profile does not exceed the worker's message quota");
	const result = restoreCompilerResult(response.value, handoff);
	if (result.profile === undefined) throw new Error("profile was not restored");
	const capture = createProfileCapture(
		"run",
		result.profile,
		directory,
		join(directory, "capture"),
	);
	const metadata = JSON.parse(
		readFileSync(join(capture.directory, "metadata.json"), "utf8"),
	) as PreparedProfile;
	if (
		metadata.functions.length !== response.count ||
		metadata.functions.at(-1)?.name !== response.lastName
	)
		throw new Error("profile capture lost the published metadata");
	process.stdout.write("compiler profile handoff passed\n");
} finally {
	await pool.close();
	rmSync(directory, { recursive: true, force: true });
}
