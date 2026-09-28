import { describe, expect, it, vi } from "vitest";
import {
	parseMicrobenchCases,
	parseMicrobenchComment,
	resolveMicrobenchRequest,
} from "../scripts/microbench-request.ts";
import type { RequestContext } from "../scripts/microbench-request.ts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function commentContext(
	body = "/microbench string-traversal,string-search",
): RequestContext {
	return {
		eventName: "issue_comment",
		event: {
			action: "created",
			issue: { number: 71, pull_request: {} },
			comment: { body, user: { login: "writer" }, author_association: "OWNER" },
		},
		repository: "owner/repo",
		actor: "writer",
		triggeringActor: "writer",
		workflowRef: "refs/heads/main",
	};
}

function dispatchContext(inputs: Record<string, unknown>): RequestContext {
	return { ...commentContext(), eventName: "workflow_dispatch", event: { inputs } };
}

function github(responses: Record<string, unknown> = {}) {
	return vi.fn((resource: string): Promise<unknown> => {
		if (resource in responses) return Promise.resolve(responses[resource]);
		if (/\/collaborators\/[^/]+\/permission$/.test(resource))
			return Promise.resolve({ permission: "write" });
		if (resource === "repos/owner/repo/commits/main")
			return Promise.resolve({ sha: baseSha });
		if (resource === "repos/owner/repo/pulls/71")
			return Promise.resolve({
				state: "open",
				head: { sha: headSha, repo: { full_name: "fork/repo" } },
				base: { repo: { full_name: "owner/repo" } },
			});
		if (resource === "repos/owner/repo/commits/perf%2Fstrings")
			return Promise.resolve({ sha: headSha });
		return Promise.reject(new Error(`Unexpected request ${resource}`));
	});
}

describe("microbench command parsing", () => {
	it("accepts one exact slash command and comma-separated case IDs", () => {
		expect(parseMicrobenchComment(" /microbench direct-calls, closure-calls \n")).toEqual(
			["direct-calls", "closure-calls"],
		);
		expect(parseMicrobenchComment("/microbench")).toEqual([]);
		expect(parseMicrobenchCases("")).toEqual([]);
	});

	it.each([
		"please /microbench direct-calls",
		"`/microbench direct-calls`",
		"/microbenchmark",
		"/Microbench direct-calls",
		"> /microbench direct-calls",
	])("ignores ordinary comment %j", (body) => {
		expect(parseMicrobenchComment(body)).toBeUndefined();
	});

	it.each([
		"/microbench foo\nbar",
		"/microbench foo;echo pwned",
		"/microbench $(whoami)",
		"/microbench --base,main",
		"/microbench ../foo",
		"/microbench foo,,bar",
		"/microbench foo,foo",
		"/microbench foo bar",
	])("rejects malformed command %j", (body) => {
		expect(() => parseMicrobenchComment(body)).toThrow();
	});

	it("bounds case selection before authorizing runner time", () => {
		expect(() =>
			parseMicrobenchCases(
				Array.from({ length: 25 }, (_, index) => `case-${index}`).join(","),
			),
		).toThrow("at most 24");
	});
});

describe("microbench authorization and revision resolution", () => {
	it("pins main and an open fork PR after checking current write access", async () => {
		const get = github();
		expect(await resolveMicrobenchRequest(commentContext(), get)).toEqual({
			pr: 71,
			checkoutRef: "refs/pull/71/head",
			headSha,
			baseSha,
			cases: ["string-traversal", "string-search"],
			pairs: 7,
			budgetSeconds: 2400,
			diagnostics: false,
		});
		expect(get.mock.calls.map(([resource]) => resource)).toEqual([
			"repos/owner/repo/collaborators/writer/permission",
			"repos/owner/repo/commits/main",
			"repos/owner/repo/pulls/71",
		]);
	});

	it.each(["read", "none", "triage", "maintain", undefined])(
		"rejects non-write API permission %s despite OWNER association",
		async (permission) => {
			const get = github({
				"repos/owner/repo/collaborators/writer/permission": {
					permission,
					role_name: "admin",
				},
			});
			await expect(resolveMicrobenchRequest(commentContext(), get)).rejects.toThrow(
				"write permission",
			);
			expect(get).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["admin", "write"])(
		"accepts documented base permission %s",
		async (permission) => {
			await expect(
				resolveMicrobenchRequest(
					commentContext(),
					github({
						"repos/owner/repo/collaborators/writer/permission": {
							permission,
							role_name: "maintain",
						},
					}),
				),
			).resolves.toBeDefined();
		},
	);

	it("checks the original comment author instead of trusting the event actor", async () => {
		const get = github({
			"repos/owner/repo/collaborators/writer/permission": { permission: "read" },
		});
		await expect(
			resolveMicrobenchRequest(
				{ ...commentContext(), actor: "admin", triggeringActor: "admin" },
				get,
			),
		).rejects.toThrow("writer");
	});

	it("rechecks the rerun initiator and fails closed when access was revoked", async () => {
		const get = github({
			"repos/owner/repo/collaborators/reader/permission": { permission: "read" },
		});
		await expect(
			resolveMicrobenchRequest({ ...commentContext(), triggeringActor: "reader" }, get),
		).rejects.toThrow("reader");
		expect(get).toHaveBeenCalledTimes(2);
	});

	it("fails closed when the permission endpoint errors", async () => {
		await expect(
			resolveMicrobenchRequest(commentContext(), () => Promise.reject(new Error("403"))),
		).rejects.toThrow("403");
	});

	it("ignores issue comments and unrelated PR comments without API calls", async () => {
		const get = github();
		expect(
			await resolveMicrobenchRequest(commentContext("looks good"), get),
		).toBeUndefined();
		expect(
			await resolveMicrobenchRequest(
				{ ...commentContext(), event: { action: "created", issue: { number: 71 } } },
				get,
			),
		).toBeUndefined();
		expect(
			await resolveMicrobenchRequest(
				{ ...commentContext(), event: { action: "edited" } },
				get,
			),
		).toBeUndefined();
		expect(get).not.toHaveBeenCalled();
	});

	it("resolves manual branch selection through the repository API", async () => {
		const get = github();
		const result = await resolveMicrobenchRequest(
			dispatchContext({
				ref: "perf/strings",
				cases: "direct-calls",
				pairs: "9",
				budget_seconds: "1800",
				diagnostics: "true",
			}),
			get,
		);
		expect(result).toMatchObject({
			pr: undefined,
			checkoutRef: headSha,
			baseSha,
			headSha,
			pairs: 9,
			budgetSeconds: 1800,
			diagnostics: true,
		});
		expect(get).toHaveBeenCalledWith("repos/owner/repo/commits/perf%2Fstrings");
	});

	it("supports manual PR selection with default controls", async () => {
		expect(
			await resolveMicrobenchRequest(dispatchContext({ pr: "71" }), github()),
		).toMatchObject({ pr: 71, cases: [], pairs: 7 });
	});

	it.each([
		{},
		{ pr: "71", ref: "main" },
		{ pr: "-1" },
		{ ref: "--help" },
		{ ref: "main\ninjection" },
		{ pr: "71", pairs: "2" },
		{ pr: "71", pairs: "22" },
		{ pr: "71", budget_seconds: "3001" },
		{ pr: "71", diagnostics: "yes" },
	])("rejects invalid manual inputs %j", async (inputs) => {
		const get = github();
		await expect(
			resolveMicrobenchRequest(dispatchContext(inputs), get),
		).rejects.toThrow();
		expect(get).not.toHaveBeenCalled();
	});

	it("only permits dispatch of the workflow from main", async () => {
		await expect(
			resolveMicrobenchRequest(
				{ ...dispatchContext({ pr: "71" }), workflowRef: "refs/heads/untrusted" },
				github(),
			),
		).rejects.toThrow("from main");
	});

	it("rejects closed, deleted, foreign, and unpinned PR revisions", async () => {
		for (const pull of [
			{ state: "closed" },
			{ state: "open", base: { repo: { full_name: "elsewhere/repo" } } },
			{
				state: "open",
				base: { repo: { full_name: "owner/repo" } },
				head: { repo: null },
			},
			{
				state: "open",
				base: { repo: { full_name: "owner/repo" } },
				head: { repo: {}, sha: "main" },
			},
		])
			await expect(
				resolveMicrobenchRequest(
					commentContext(),
					github({ "repos/owner/repo/pulls/71": pull }),
				),
			).rejects.toThrow();
	});
});
