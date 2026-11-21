import type { MessagePort, WorkerExit } from "maligator:workers";

export interface ApplicationImageDescriptor {
	schema: 2;
	wires: Array<{ path: string; sha256: string }>;
	entryPath: string;
	workerManifestPath?: string;
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
	/**
	 * Keep the sockets this application listens on open after it ends, so a client of
	 * the next launch on the same address waits instead of being refused. They stay
	 * open until a launch listens there again or `releaseUnclaimedListeners` runs.
	 */
	retainListeners?: boolean;
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
	resources?(): ApplicationResources;
	/** Closes retained listening sockets that no running application listens on. */
	releaseUnclaimedListeners?(): void;
}

export interface ApplicationResources {
	loadedImages: number;
	runningApplications: number;
	ownedWorkers: number;
	processWorkers: number;
	processImageDomains: number;
	/** Retained worker-domain wires, excluding application roots and baked code. */
	processWorkerWireBytes: number;
	/** Listening sockets held for `retainListeners` launches, in use or not. */
	retainedListeners: number;
}

export interface NativeApplicationBridge {
	_loadApplicationImage(descriptor: ApplicationImageDescriptor): object;
	_launchApplicationImage(
		handle: object,
		options: ApplicationLaunchOptions,
	): ApplicationInstance;
	_releaseApplicationImage(handle: object): void;
	_applicationResources(): ApplicationResources;
	_releaseUnclaimedListeners(): number;
}

export function createApplicationImageHost(
	bridge: NativeApplicationBridge,
): ApplicationImageHost {
	return {
		resources: () => bridge._applicationResources(),
		releaseUnclaimedListeners() {
			bridge._releaseUnclaimedListeners();
		},
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
