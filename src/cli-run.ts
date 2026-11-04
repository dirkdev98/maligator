import { execFileSync, spawn } from "node:child_process";

export interface RunOutcome {
	status?: number;
	signal?: NodeJS.Signals;
}

export function executeBinary(
	binaryPath: string,
	args: Array<string>,
	env: NodeJS.ProcessEnv,
	stdio: "inherit" | "ignore" = "inherit",
): RunOutcome {
	try {
		execFileSync(binaryPath, args, { env, stdio });
		return { status: 0 };
	} catch (error) {
		const result = error as {
			status?: number | null;
			signal?: NodeJS.Signals | null;
		};
		return {
			status: result.status ?? undefined,
			signal: result.signal ?? undefined,
		};
	}
}

export interface ReportedRunOutcome extends RunOutcome {
	result?: string;
	timedOut?: true;
}

/** Stream application output while retaining only its optional result record. */
export function executeBinaryReported(
	binaryPath: string,
	args: Array<string>,
	env: NodeJS.ProcessEnv,
	options: {
		timeoutMs?: number;
		resultPrefix?: string;
		stdout?: (text: string) => void;
		stderr?: (text: string) => void;
	} = {},
): Promise<ReportedRunOutcome> {
	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let timedOut = false;
		let failure: Error | undefined;
		let result: string | undefined;
		let mode: "prefix" | "output" | "result" = "prefix";
		let prefix = "";
		const resultChunks: Array<string> = [];
		const publish = (stream: "stdout" | "stderr", text: string) => {
			if (text.length === 0) return;
			const custom = options[stream];
			if (custom !== undefined) custom(text);
			else if (!process[stream].write(text)) {
				child[stream].pause();
				process[stream].once("drain", () => child[stream].resume());
			}
		};
		const finishResult = () => {
			result ??= resultChunks.join("");
			resultChunks.length = 0;
		};
		const consume = (text: string) => {
			const expected = options.resultPrefix;
			if (expected === undefined || expected.length === 0) {
				publish("stdout", text);
				return;
			}
			let start = 0;
			while (start < text.length) {
				if (mode === "prefix") {
					while (start < text.length && text[start] === expected[prefix.length]) {
						prefix += text[start++]!;
						if (prefix.length === expected.length) {
							prefix = "";
							mode = "result";
							break;
						}
					}
					if (mode === "prefix") {
						if (start === text.length) return;
						publish("stdout", prefix);
						prefix = "";
						mode = "output";
					}
				}
				const newline = text.indexOf("\n", start);
				const end = newline < 0 ? text.length : newline;
				if (mode === "result") {
					if (result === undefined) resultChunks.push(text.slice(start, end));
					if (newline >= 0) finishResult();
				} else publish("stdout", text.slice(start, newline < 0 ? end : end + 1));
				if (newline < 0) return;
				start = newline + 1;
				mode = "prefix";
			}
		};
		const guard = (read: (text: string) => void) => (text: string) => {
			try {
				read(text);
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
				child.kill("SIGKILL");
			}
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", guard(consume));
		child.stderr.on(
			"data",
			guard((text) => publish("stderr", text)),
		);
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						child.kill("SIGKILL");
					}, options.timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (failure !== undefined) {
				reject(failure);
				return;
			}
			try {
				if (mode === "result") finishResult();
				else publish("stdout", prefix);
				resolve({
					status: code ?? undefined,
					signal: signal ?? undefined,
					...(result === undefined ? {} : { result }),
					...(timedOut ? { timedOut: true } : {}),
				});
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
