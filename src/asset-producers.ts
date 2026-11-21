import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { BuildConfigError } from "./build-config-error.ts";
import type {
	EmbedDeclaration,
	EmbedProducer,
	EmbedWatchProducer,
} from "./compiler/frontend/embed-declarations.ts";

/** The Maligator commands an embed declaration's `use` option distinguishes. */
export type ProducerCommand = "build" | "run" | "test" | "dev";

export interface ProducerTask {
	readonly mode: "build" | "watch";
	readonly producer: EmbedWatchProducer;
	/** The declared paths the producer writes, for messages. */
	readonly outputs: ReadonlyArray<string>;
}

/**
 * The producer each declaration selects for `command`. Without a `use` entry, `build`
 * and `run` build, `test` uses the files that exist, and `dev` watches when the
 * declaration defines a watcher. Declarations naming the same command and directory
 * share one task.
 */
export function producerTasks(
	declarations: ReadonlyArray<EmbedDeclaration>,
	command: ProducerCommand,
): Array<ProducerTask> {
	const tasks = new Map<string, ProducerTask & { outputs: Array<string> }>();
	for (const declaration of declarations) {
		if (declaration.build === undefined && declaration.watch === undefined) continue;
		const fallback =
			command === "test"
				? "existing"
				: command === "dev" && declaration.watch !== undefined
					? "watch"
					: "build";
		const mode = declaration.use?.[command] ?? fallback;
		if (mode === "existing") continue;
		const producer = declaration[mode];
		if (producer === undefined) continue;
		const key = JSON.stringify([mode, producer]);
		const task = tasks.get(key);
		if (task === undefined)
			tasks.set(key, { mode, producer, outputs: [declaration.path] });
		else if (!task.outputs.includes(declaration.path))
			task.outputs.push(declaration.path);
	}
	return [...tasks.values()];
}

function describe(producer: EmbedProducer): string {
	return `${producer.command.join(" ")} (in ${producer.cwd})`;
}

/** Run each build producer to completion, in declaration order. */
export function runBuildProducers(
	tasks: ReadonlyArray<ProducerTask>,
	log: (message: string) => void,
): void {
	for (const task of tasks) {
		if (task.mode !== "build") continue;
		const [executable, ...args] = task.producer.command;
		log(`Producing ${task.outputs.join(", ")}: ${describe(task.producer)}`);
		const result = spawnSync(executable!, args, {
			cwd: task.producer.cwd,
			stdio: ["ignore", "inherit", "inherit"],
		});
		if (result.error !== undefined)
			throw new BuildConfigError(
				`cannot run ${describe(task.producer)}: ${result.error.message}`,
			);
		if (result.status !== 0)
			throw new BuildConfigError(
				`${describe(task.producer)} failed with ${result.signal ?? `exit code ${result.status}`}`,
			);
	}
}

interface RunningWatcher {
	readonly child: ChildProcess;
	readonly exited: Promise<string>;
	ready?: Promise<void>;
}

/** How long a watcher's `url` may take to answer before the command gives up. */
const WATCH_READY_TIMEOUT_MS = 120_000;

/**
 * Long-running producers a command keeps for its whole lifetime: `dev` across
 * application generations, `test --watch` across reruns. Each runs in its own
 * process group so stopping it also stops the servers it starts.
 */
export class WatchProducers {
	readonly #running = new Map<string, RunningWatcher>();
	readonly #log: (message: string) => void;

	constructor(log: (message: string) => void) {
		this.#log = log;
	}

	/** Start the watchers not yet running and wait until each `url` answers. */
	async ensure(tasks: ReadonlyArray<ProducerTask>): Promise<void> {
		const pending: Array<Promise<void>> = [];
		for (const task of tasks) {
			if (task.mode !== "watch") continue;
			const key = JSON.stringify(task.producer);
			let watcher = this.#running.get(key);
			if (watcher === undefined) {
				watcher = this.#start(task);
				this.#running.set(key, watcher);
			}
			if (watcher.ready !== undefined) pending.push(watcher.ready);
		}
		await Promise.all(pending);
	}

	#start(task: ProducerTask): RunningWatcher {
		const [executable, ...args] = task.producer.command;
		this.#log(`Watching ${task.outputs.join(", ")}: ${describe(task.producer)}`);
		const child = spawn(executable!, args, {
			cwd: task.producer.cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "inherit", "inherit"],
		});
		const exited = new Promise<string>((resolve) => {
			child.once("error", (error) => resolve(error.message));
			child.once("exit", (code, signal) =>
				resolve(signal === null ? `exit code ${code}` : signal),
			);
		});
		const watcher: RunningWatcher = { child, exited };
		const url = task.producer.url;
		if (url !== undefined) watcher.ready = this.#awaitUrl(task.producer, url, exited);
		return watcher;
	}

	async #awaitUrl(producer: EmbedProducer, url: string, exited: Promise<string>) {
		let stopped: string | undefined;
		void exited.then((reason) => {
			stopped = reason;
		});
		const deadline = Date.now() + WATCH_READY_TIMEOUT_MS;
		for (;;) {
			if (stopped !== undefined)
				throw new BuildConfigError(
					`${describe(producer)} stopped with ${stopped} before ${url} answered`,
				);
			try {
				await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2000) });
				return;
			} catch {
				// Not listening yet.
			}
			if (Date.now() > deadline)
				throw new BuildConfigError(
					`${url} did not answer within ${WATCH_READY_TIMEOUT_MS / 1000}s of starting ${describe(producer)}`,
				);
			await delay(250);
		}
	}

	/** Stop every watcher and wait for it to exit. */
	async close(): Promise<void> {
		const watchers = [...this.#running.values()];
		this.#running.clear();
		await Promise.all(
			watchers.map(async ({ child, exited }) => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				const signal = (name: NodeJS.Signals) => {
					try {
						// The negative pid reaches the whole process group.
						if (child.pid !== undefined)
							process.kill(process.platform === "win32" ? child.pid : -child.pid, name);
					} catch {
						// Already gone.
					}
				};
				signal("SIGTERM");
				const forced = setTimeout(() => signal("SIGKILL"), 5000);
				await exited;
				clearTimeout(forced);
			}),
		);
	}
}

/**
 * The producers of one command invocation: build producers run once, watchers stay up
 * until `close`. Later declarations, such as a new generation's, add their producers.
 */
export class CommandProducers {
	readonly #command: ProducerCommand;
	readonly #log: (message: string) => void;
	readonly #built = new Set<string>();
	readonly #watchers: WatchProducers;

	constructor(command: ProducerCommand, log: (message: string) => void) {
		this.#command = command;
		this.#log = log;
		this.#watchers = new WatchProducers(log);
	}

	async prepare(declarations: ReadonlyArray<EmbedDeclaration>): Promise<void> {
		const tasks = producerTasks(declarations, this.#command);
		const builds = tasks.filter((task) => {
			if (task.mode !== "build") return false;
			const key = JSON.stringify(task.producer);
			if (this.#built.has(key)) return false;
			this.#built.add(key);
			return true;
		});
		runBuildProducers(builds, this.#log);
		await this.#watchers.ensure(tasks);
	}

	close(): Promise<void> {
		return this.#watchers.close();
	}
}
