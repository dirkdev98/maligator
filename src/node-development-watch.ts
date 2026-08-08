import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import * as path from "node:path";
import type { DevelopmentWatchHost } from "./cli-commands.ts";

interface NodeDevelopmentWatcher {
	watchers: Map<string, FSWatcher>;
	pending: boolean;
	wake: (() => void) | undefined;
}

function notify(handle: NodeDevelopmentWatcher): void {
	handle.pending = true;
	handle.wake?.();
}

function updateDirectories(handle: NodeDevelopmentWatcher, files: Array<string>): void {
	const directories = new Set(files.map((file) => path.dirname(path.resolve(file))));
	for (const [directory, watcher] of handle.watchers) {
		if (directories.has(directory)) continue;
		watcher.close();
		handle.watchers.delete(directory);
	}
	for (const directory of directories) {
		if (handle.watchers.has(directory)) continue;
		try {
			const watcher = watch(directory, { persistent: false }, () => notify(handle));
			watcher.on("error", () => {
				watcher.close();
				handle.watchers.delete(directory);
				notify(handle);
			});
			handle.watchers.set(directory, watcher);
		} catch {
			// The coordinator's identity scan remains the polling fallback for paths
			// whose filesystem does not provide watch events.
		}
	}
}

export const nodeDevelopmentWatchHost: DevelopmentWatchHost = {
	create(files) {
		const handle: NodeDevelopmentWatcher = {
			watchers: new Map(),
			pending: false,
			wake: undefined,
		};
		updateDirectories(handle, files);
		return handle;
	},
	update(handle, files) {
		updateDirectories(handle as NodeDevelopmentWatcher, files);
	},
	async wait(opaqueHandle, timeoutMs) {
		const handle = opaqueHandle as NodeDevelopmentWatcher;
		if (handle.pending) {
			handle.pending = false;
			return;
		}
		await new Promise<void>((resolve) => {
			let complete = false;
			const finish = () => {
				if (complete) return;
				complete = true;
				clearTimeout(timer);
				handle.wake = undefined;
				handle.pending = false;
				resolve();
			};
			const timer = setTimeout(finish, timeoutMs);
			handle.wake = finish;
			if (handle.pending) finish();
		});
	},
	close(opaqueHandle) {
		const handle = opaqueHandle as NodeDevelopmentWatcher;
		for (const watcher of handle.watchers.values()) watcher.close();
		handle.watchers.clear();
		handle.wake?.();
	},
};
