import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type ObjectValue = Record<string, unknown>;

export interface MicrobenchRequest {
	readonly pr: number | undefined;
	readonly checkoutRef: string;
	readonly headSha: string;
	readonly baseSha: string;
	readonly cases: ReadonlyArray<string>;
	readonly pairs: number;
	readonly budgetSeconds: number;
	readonly diagnostics: boolean;
}

export interface RequestContext {
	readonly eventName: string;
	readonly event: unknown;
	readonly repository: string;
	readonly actor: string;
	readonly triggeringActor: string;
	readonly workflowRef: string;
}

function object(value: unknown, label: string): ObjectValue {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as ObjectValue;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function positiveInteger(
	value: unknown,
	label: string,
	min: number,
	max: number,
): number {
	if (!/^[0-9]+$/.test(String(value))) throw new Error(`${label} must be an integer`);
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < min || result > max)
		throw new Error(`${label} must be between ${min} and ${max}`);
	return result;
}

function sha(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
		throw new Error("GitHub did not return a full commit SHA");
	return value;
}

export function parseMicrobenchCases(value: string): Array<string> {
	if (value.length > 4096) throw new Error("Case selection is too long");
	if (value.trim() === "") return [];
	const cases = value.split(",").map((id) => id.trim());
	if (cases.length > 24) throw new Error("Select at most 24 cases per run");
	if (cases.some((id) => !/^[a-z0-9][a-z0-9-]{0,95}$/.test(id)))
		throw new Error("Use comma-separated runtime-gap case IDs");
	if (new Set(cases).size !== cases.length) throw new Error("Case IDs must not repeat");
	return cases;
}

/** Only a complete, single-line slash command authorizes benchmark execution. */
export function parseMicrobenchComment(body: string): Array<string> | undefined {
	const text = body.trim();
	if (!/^\/microbench(?:\s|$)/.test(text)) return undefined;
	const match = /^\/microbench(?:[ \t]+([^\r\n]*))?$/.exec(text);
	if (match === null)
		throw new Error("Use /microbench case-one,case-two on a single line");
	return parseMicrobenchCases(match[1] ?? "");
}

export async function resolveMicrobenchRequest(
	context: RequestContext,
	get: (resource: string) => Promise<unknown>,
): Promise<MicrobenchRequest | undefined> {
	const event = object(context.event, "event");
	let pr: number | undefined;
	let ref: string | undefined;
	let cases: Array<string>;
	let requester = context.actor;
	let pairs = 7;
	let budgetSeconds = 2400;
	let diagnostics = false;
	if (context.eventName === "issue_comment") {
		if (event.action !== "created") return undefined;
		const issue = object(event.issue, "issue");
		if (!issue.pull_request) return undefined;
		const comment = object(event.comment, "comment");
		const selected = parseMicrobenchComment(string(comment.body, "comment body"));
		if (selected === undefined) return undefined;
		cases = selected;
		pr = positiveInteger(issue.number, "PR number", 1, 2_147_483_647);
		requester = string(
			object(comment.user, "comment author").login,
			"comment author login",
		);
	} else if (context.eventName === "workflow_dispatch") {
		if (context.workflowRef !== "refs/heads/main")
			throw new Error(
				"Dispatch this workflow from main; choose the candidate with pr or ref",
			);
		const inputs = object(event.inputs, "inputs");
		const prText = string(inputs.pr ?? "", "pr").trim();
		const refText = string(inputs.ref ?? "", "ref").trim();
		if (prText.length > 0 === refText.length > 0)
			throw new Error("Provide exactly one of pr or ref");
		if (prText) pr = positiveInteger(prText, "PR number", 1, 2_147_483_647);
		else {
			if (refText.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(refText))
				throw new Error("ref must be a branch, tag, or commit SHA in this repository");
			ref = refText;
		}
		cases = parseMicrobenchCases(string(inputs.cases ?? "", "cases"));
		pairs = positiveInteger(inputs.pairs ?? "7", "pairs", 3, 21);
		budgetSeconds = positiveInteger(
			inputs.budget_seconds ?? "2400",
			"budget_seconds",
			60,
			3000,
		);
		if (
			![undefined, false, true, "false", "true"].includes(
				inputs.diagnostics as boolean | string | undefined,
			)
		)
			throw new Error("diagnostics must be true or false");
		diagnostics = inputs.diagnostics === true || inputs.diagnostics === "true";
	} else throw new Error(`Unsupported event: ${context.eventName}`);

	if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(context.repository))
		throw new Error("Invalid repository name");
	const repoPath = `repos/${context.repository}`;
	// Recheck both identities on reruns; author_association and custom role names
	// do not establish current write permission. GitHub maps maintain to write.
	for (const username of new Set([requester, context.triggeringActor])) {
		if (!username) throw new Error("Missing requester identity");
		const access = object(
			await get(`${repoPath}/collaborators/${encodeURIComponent(username)}/permission`),
			"repository permission",
		);
		if (access.permission !== "write" && access.permission !== "admin")
			throw new Error(`${username} does not currently have repository write permission`);
	}

	const base = object(await get(`${repoPath}/commits/main`), "main commit");
	const baseSha = sha(base.sha);
	let headSha: string;
	if (pr !== undefined) {
		const pull = object(await get(`${repoPath}/pulls/${pr}`), "pull request");
		if (pull.state !== "open") throw new Error("The pull request must be open");
		const baseRepo = object(object(pull.base, "PR base").repo, "PR base repository");
		if (baseRepo.full_name !== context.repository)
			throw new Error("The pull request belongs to a different repository");
		const head = object(pull.head, "PR head");
		if (head.repo === null)
			throw new Error("The pull request head repository was deleted");
		headSha = sha(head.sha);
	} else {
		const head = object(
			await get(`${repoPath}/commits/${encodeURIComponent(ref!)}`),
			"candidate commit",
		);
		headSha = sha(head.sha);
	}
	return {
		pr,
		// The repository's PR ref also works for fork heads. The build job verifies
		// HEAD against headSha and fails if this mutable ref moved after resolution.
		checkoutRef: pr === undefined ? headSha : `refs/pull/${pr}/head`,
		headSha,
		baseSha,
		cases,
		pairs,
		budgetSeconds,
		diagnostics,
	};
}

async function main(): Promise<void> {
	const token = process.env.MICROBENCH_TOKEN;
	if (!token) throw new Error("MICROBENCH_TOKEN is required for request authorization");
	const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
	const request = await resolveMicrobenchRequest(
		{
			eventName: process.env.GITHUB_EVENT_NAME!,
			event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")),
			repository: process.env.GITHUB_REPOSITORY!,
			actor: process.env.GITHUB_ACTOR!,
			triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR!,
			workflowRef: process.env.GITHUB_REF!,
		},
		async (resource) => {
			const response = await fetch(`${api}/${resource}`, {
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok)
				throw new Error(`GitHub request failed: ${response.status} ${resource}`);
			return response.json();
		},
	);
	appendFileSync(process.env.GITHUB_OUTPUT!, `requested=${request !== undefined}\n`);
	if (request === undefined) return;
	const outputs = {
		pr: request.pr ?? "",
		checkout_ref: request.checkoutRef,
		head_sha: request.headSha,
		base_sha: request.baseSha,
		cases: request.cases.join(","),
		pairs: request.pairs,
		budget_seconds: request.budgetSeconds,
		diagnostics: request.diagnostics,
	};
	for (const [key, value] of Object.entries(outputs))
		appendFileSync(process.env.GITHUB_OUTPUT!, `${key}=${value}\n`);
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY!,
		[
			"## Native microbenchmark request",
			"",
			`Candidate: \`${request.headSha}\`${request.pr === undefined ? "" : ` (PR #${request.pr})`}`,
			`Baseline: \`${request.baseSha}\` (main at authorization time)`,
			`Cases: ${request.cases.length === 0 ? "default native micro suite" : request.cases.map((id) => `\`${id}\``).join(", ")}`,
			`Pairs: ${request.pairs}; comparison budget: ${request.budgetSeconds} seconds.`,
			"",
		].join("\n\n"),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
