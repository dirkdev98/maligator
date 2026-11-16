import { execFileSync } from "node:child_process";

const HELP = `Usage: npm run ci:status -- <commit>

Reports the CI, Native remainder, Extended CI and Test262 runs of one commit pushed to
main, with the jobs that did not pass and the Test262 regression count. Pass the commit a
push ended on: only the tip of a push gets runs.

Exit code: 0 when every run passed, 1 when one failed, 2 while one is pending.`;

type Verdict = "passed" | "failed" | "pending";

interface WorkflowRun {
	readonly id: number;
	readonly event: string;
	readonly status: string;
	readonly conclusion: string | null;
	readonly display_title: string;
	readonly html_url: string;
	readonly run_attempt: number;
}

interface WorkflowJob {
	readonly id: number;
	readonly name: string;
	readonly status: string;
	readonly conclusion: string | null;
	readonly html_url: string;
}

interface Annotation {
	readonly title: string | null;
	readonly message: string;
}

const PUSH_WORKFLOWS = [
	{ file: "ci.yml", name: "CI" },
	{ file: "native-remainder.yml", name: "Native remainder" },
	{ file: "extended-ci.yml", name: "Extended CI" },
] as const;

// Superseded runs in a concurrency group end cancelled; that commit's coverage comes
// from the later run, so a cancelled run neither fails nor holds the verdict.
const NEUTRAL_CONCLUSIONS = new Set(["success", "skipped", "neutral", "cancelled"]);

function gh<T>(endpoint: string): T {
	return JSON.parse(
		execFileSync("gh", ["api", endpoint], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		}),
	) as T;
}

function runJobs(run: WorkflowRun): Array<WorkflowJob> {
	const jobs: Array<WorkflowJob> = [];
	for (let page = 1; ; page++) {
		const { jobs: pageJobs } = gh<{ jobs: Array<WorkflowJob> }>(
			`repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`,
		);
		jobs.push(...pageJobs);
		if (pageJobs.length < 100) return jobs;
	}
}

function runVerdict(run: WorkflowRun | undefined): Verdict {
	if (run === undefined || run.status !== "completed") return "pending";
	return NEUTRAL_CONCLUSIONS.has(run.conclusion ?? "") ? "passed" : "failed";
}

function test262Regressions(jobs: ReadonlyArray<WorkflowJob>): string | undefined {
	const report = jobs.find(({ name }) => name === "Test262 report");
	if (report?.status !== "completed") return undefined;
	const annotations = gh<Array<Annotation>>(
		`repos/{owner}/{repo}/check-runs/${report.id}/annotations`,
	);
	return annotations.find(({ title }) => title === "Test262")?.message;
}

function describeRun(
	name: string,
	run: WorkflowRun | undefined,
	missing: string,
): { verdict: Verdict; lines: Array<string> } {
	const verdict = runVerdict(run);
	if (run === undefined) {
		return { verdict, lines: [`${name.padEnd(17)} ${missing}`] };
	}
	const jobs = runJobs(run);
	const done = jobs.filter(({ status }) => status === "completed");
	const state = run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;
	const attempt = run.run_attempt > 1 ? `, attempt ${run.run_attempt}` : "";
	const progress =
		run.status === "completed"
			? `${jobs.length} jobs${attempt}`
			: `${done.length}/${jobs.length} jobs done${attempt}`;
	const lines = [`${name.padEnd(17)} ${state} (${progress}) ${run.html_url}`];
	for (const job of done) {
		if (!NEUTRAL_CONCLUSIONS.has(job.conclusion ?? "")) {
			lines.push(`  ${job.conclusion}: ${job.name} ${job.html_url}`);
		}
	}
	if (name === "Test262") {
		const regressions = test262Regressions(jobs);
		if (regressions !== undefined) lines.push(`  ${regressions}`);
	}
	return { verdict, lines };
}

function main(args: ReadonlyArray<string>): number {
	if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
		console.log(HELP);
		return args.length === 1 ? 0 : 1;
	}
	const sha = execFileSync("git", ["rev-parse", "--verify", `${args[0]}^{commit}`], {
		encoding: "utf8",
	}).trim();
	console.log(
		execFileSync("git", ["log", "-1", "--format=%h %s", sha], {
			encoding: "utf8",
		}).trim(),
	);

	const verdicts: Array<Verdict> = [];
	let ciRun: WorkflowRun | undefined;
	for (const workflow of PUSH_WORKFLOWS) {
		const { workflow_runs: runs } = gh<{ workflow_runs: Array<WorkflowRun> }>(
			`repos/{owner}/{repo}/actions/workflows/${workflow.file}/runs?head_sha=${sha}&per_page=20`,
		);
		const run = runs.find(({ event }) => event !== "pull_request");
		if (workflow.file === "ci.yml") ciRun = run;
		const { verdict, lines } = describeRun(workflow.name, run, "not started");
		verdicts.push(verdict);
		console.log(lines.join("\n"));
	}

	// Test262 starts from CI's completion on whatever main is then, so its head_sha can
	// name a later commit. Its run name carries the commit it checked out.
	const { workflow_runs: test262Runs } = gh<{ workflow_runs: Array<WorkflowRun> }>(
		"repos/{owner}/{repo}/actions/workflows/test262.yml/runs?per_page=100",
	);
	const test262Run = test262Runs.find(
		({ display_title }) => display_title === `Test262 ${sha}`,
	);
	const ciVerdict = runVerdict(ciRun);
	const test262 = describeRun(
		"Test262",
		test262Run,
		{
			failed: "not run, CI failed",
			pending: "waits for CI",
			passed: "no run names this commit yet",
		}[ciVerdict],
	);
	if (test262Run !== undefined || ciVerdict !== "failed") verdicts.push(test262.verdict);
	console.log(test262.lines.join("\n"));

	const overall: Verdict = verdicts.includes("failed")
		? "failed"
		: verdicts.includes("pending")
			? "pending"
			: "passed";
	console.log(`Verdict: ${overall}`);
	return { passed: 0, failed: 1, pending: 2 }[overall];
}

process.exitCode = main(process.argv.slice(2));
