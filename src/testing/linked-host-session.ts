import type { ApplicationImageHost } from "../application-images.ts";
import type { ResolvedBuildConfig } from "../build-config.ts";
import type { NativeTestInputs, TestApplicationHost } from "./application-host.ts";
import { startLinkedTestHost } from "./linked-host.ts";
import type { LinkedTestHost } from "./linked-host.ts";
import type { TestGenerationControls } from "./session.ts";

export interface PreparedLinkedTestHost {
	config: ResolvedBuildConfig;
	native: NativeTestInputs;
	build(): { executable: string; wires: Array<string>; entry: string };
	validate(): void;
}

export class LinkedTestHostSession implements TestApplicationHost {
	readonly #fallback: ApplicationImageHost | undefined;
	#current:
		| { buildIdentity: string; native: NativeTestInputs; host: LinkedTestHost }
		| undefined;
	#instances = 0;
	#closing: Promise<void> | undefined;

	constructor(fallback?: ApplicationImageHost) {
		this.#fallback = fallback;
	}
	get native(): NativeTestInputs | undefined {
		return this.#current?.native;
	}
	resources() {
		return (
			this.#current?.host.resources?.() ??
			this.#fallback?.resources?.() ?? {
				loadedImages: 0,
				runningApplications: 0,
				ownedWorkers: 0,
				processWorkers: 0,
				processImageDomains: 0,
				processWorkerWireBytes: 0,
			}
		);
	}
	load(...args: Parameters<TestApplicationHost["load"]>) {
		const host = this.#current?.host ?? this.#fallback;
		if (this.#closing !== undefined || host === undefined)
			throw new Error("test application host is unavailable");
		return host.load(...args);
	}
	async activate(
		prepared: PreparedLinkedTestHost,
		controls: TestGenerationControls,
	): Promise<ResolvedBuildConfig> {
		if (this.#closing !== undefined) throw new Error("test application host is closing");
		controls.signal?.throwIfAborted();
		const current = this.#current;
		if (current?.buildIdentity === prepared.native.identity && current.host.alive) {
			// Native preparation can block exit-event delivery. An acknowledged request
			// proves the host still exists before this generation reuses its state.
			try {
				await current.host.check();
			} catch (error) {
				if (current.host.alive) throw error;
			}
			controls.signal?.throwIfAborted();
			if (this.#closing !== undefined)
				throw new Error("test application host is closing");
			if (current.host.alive) {
				current.native = { ...prepared.native, identity: current.native.identity };
				return prepared.config;
			}
		}
		const bundle = prepared.build();
		prepared.validate();
		controls.signal?.throwIfAborted();
		const host = await startLinkedTestHost({ ...bundle, signal: controls.signal });
		try {
			prepared.validate();
			controls.signal?.throwIfAborted();
			const previous = this.#current;
			this.#current = undefined;
			await this.#retire(previous?.host);
			prepared.validate();
			controls.signal?.throwIfAborted();
			this.#current = {
				buildIdentity: prepared.native.identity,
				native: {
					...prepared.native,
					identity: `${prepared.native.identity}:${String(++this.#instances)}`,
				},
				host,
			};
		} catch (error) {
			await host.close();
			throw error;
		}
		return prepared.config;
	}
	async useLocal(): Promise<void> {
		const previous = this.#current;
		this.#current = undefined;
		await this.#retire(previous?.host);
	}
	async #retire(host: LinkedTestHost | undefined): Promise<void> {
		if (host === undefined) return;
		if (host.alive) await host.close();
		else {
			// A failed host still must join before its replacement can own applications.
			await host.close().catch(() => {});
		}
	}
	close(): Promise<void> {
		return (this.#closing ??= this.useLocal());
	}
}
