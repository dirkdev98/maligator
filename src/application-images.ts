import type { MessagePort, WorkerExit } from "maligator:workers";

export interface ApplicationImageDescriptor {
	schema: 1;
	wires: Array<{ path: string; sha256: string }>;
	entryPath: string;
	workerManifestPath?: string;
	assetManifestPath?: string;
	webPlatform: boolean;
	node: boolean;
	engine: {
		primordials: "locked" | "mutable";
		eval: boolean;
		realms: boolean;
		regexp: boolean;
		temporal: boolean;
		intl: boolean;
	};
}

export interface ApplicationLaunchOptions {
	argv: Array<string>;
	name?: string;
	data?: unknown;
	exitOnResult?: boolean;
}

export interface ApplicationExit extends WorkerExit {
	readonly hasResult: boolean;
	readonly result?: unknown;
}

export interface ApplicationInstance {
	readonly id: number;
	/** Entry evaluation completed, including top-level await. */
	readonly ready: Promise<void>;
	/** Explicit application readiness; rejects if the isolate exits before signaling. */
	readonly applicationReady: Promise<void>;
	/** Settles after native resources and descendant workers have been joined. */
	readonly closed: Promise<ApplicationExit>;
	readonly port: MessagePort;
	terminate(): Promise<ApplicationExit>;
	ref(): void;
	unref(): void;
}

export interface ApplicationImage {
	launch(options: ApplicationLaunchOptions): ApplicationInstance;
	/** Releases the supervisor's reference; existing launches retain their image domain. */
	close(): void;
}

export interface ApplicationImageHost {
	load(descriptor: ApplicationImageDescriptor): ApplicationImage;
}

export interface NativeApplicationBridge {
	_loadApplicationImage(descriptor: ApplicationImageDescriptor): object;
	_launchApplicationImage(
		handle: object,
		options: ApplicationLaunchOptions,
	): ApplicationInstance;
	_releaseApplicationImage(handle: object): void;
}

export function createApplicationImageHost(
	bridge: NativeApplicationBridge,
): ApplicationImageHost {
	return {
		load(descriptor) {
			const handle = bridge._loadApplicationImage(descriptor);
			let closed = false;
			return {
				launch(options) {
					if (closed) throw new Error("application image is closed");
					return bridge._launchApplicationImage(handle, options);
				},
				close() {
					if (closed) return;
					closed = true;
					bridge._releaseApplicationImage(handle);
				},
			};
		},
	};
}
