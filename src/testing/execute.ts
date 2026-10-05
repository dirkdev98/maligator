import type { ApplicationImage, ApplicationImageHost } from "../application-images.ts";
import type { PreparedTestApplication } from "./prepare.ts";
import type { TestRunOptions, TestRunResult } from "./protocol.ts";

function isTestRunResult(value: unknown): value is TestRunResult {
	if (value === null || typeof value !== "object") return false;
	const result = value as Partial<TestRunResult>;
	return (
		Array.isArray(result.events) &&
		Array.isArray(result.files) &&
		["passed", "failed", "skipped", "todo", "durationMs"].every((key) => {
			const count = Reflect.get(result, key) as unknown;
			return typeof count === "number" && Number.isFinite(count) && count >= 0;
		}) &&
		typeof result.focused === "boolean"
	);
}

export async function executeTestApplication(
	host: ApplicationImageHost,
	prepared: PreparedTestApplication,
	options: TestRunOptions,
	controls: { image?: ApplicationImage; signal?: AbortSignal } = {},
): Promise<TestRunResult> {
	const selectedFiles = options.files ?? prepared.files;
	if (selectedFiles.some((file) => !prepared.files.includes(file)))
		throw new Error("test selection is outside the compiled application");
	controls.signal?.throwIfAborted();
	const image = controls.image ?? host.load(prepared.image);
	try {
		const application = image.launch({
			argv: [process.argv[0]!, prepared.image.entryPath],
			name: "test",
			data: { ...options, files: selectedFiles },
			exitOnResult: true,
		});
		void application.applicationReady.catch(() => {});
		let termination: ReturnType<typeof application.terminate> | undefined;
		const terminate = () => (termination ??= application.terminate());
		let cancel!: (error: Error) => void;
		const canceled = new Promise<never>((_resolve, reject) => {
			cancel = reject;
		});
		const abort = () => {
			void terminate().catch(() => {});
			const reason: unknown = controls.signal?.reason;
			cancel(reason instanceof Error ? reason : new Error(String(reason)));
		};
		controls.signal?.addEventListener("abort", abort, { once: true });
		try {
			if (controls.signal?.aborted) abort();
			await Promise.race([application.ready, canceled]);
			const outcome = await application.closed;
			controls.signal?.throwIfAborted();
			if (outcome.reason === "error") throw outcome.error;
			if (outcome.reason !== "completed" || outcome.code !== 0) {
				throw new Error(`test image ${outcome.reason} with exit code ${outcome.code}`);
			}
			if (!outcome.hasResult || !isTestRunResult(outcome.result)) {
				throw new Error("test image exited without publishing a valid test result");
			}
			return outcome.result;
		} finally {
			controls.signal?.removeEventListener("abort", abort);
			try {
				await terminate();
			} finally {
				await application.closed;
			}
		}
	} finally {
		if (controls.image === undefined) image.close();
	}
}
