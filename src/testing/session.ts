import type { ApplicationImage, ApplicationImageHost } from "../application-images.ts";
import type { CompilationOptions } from "../compiler-service.ts";
import { frontendDependencyUnchanged } from "../frontend-cache.ts";
import { TestCompilationSession } from "./cache.ts";
import type { PreparedTestApplication, TestCompilationInput } from "./prepare.ts";
import type { TestRunOptions } from "./protocol.ts";

export interface TestGenerationControls extends CompilationOptions {
	generation?: number;
	isCurrent?: () => boolean;
	selectedFiles?: Array<string>;
	prepared?: (application: PreparedTestApplication) => void;
	validate?: () => Array<string>;
}

export class TestSourceChangedError extends Error {
	readonly paths: Array<string>;
	constructor(paths: Array<string>) {
		super("test sources changed before results could be published");
		this.paths = paths;
	}
}

export class TestApplicationSession {
	readonly frontend: TestCompilationSession;
	readonly options: TestRunOptions;
	readonly #prepared = new Map<string, PreparedTestApplication>();
	readonly #images = new Map<string, ApplicationImage>();
	readonly #used = new Set<string>();
	#closed = false;

	constructor(options: TestRunOptions, frontend = new TestCompilationSession()) {
		this.options = Object.freeze({ ...options });
		this.frontend = frontend;
	}

	begin(controls: TestGenerationControls): void {
		if (this.#closed) throw new Error("test application session is closed");
		this.#used.clear();
		if (controls.invalidateAll) this.frontend.invalidate();
		else
			for (const file of controls.invalidatedPaths ?? []) this.frontend.invalidate(file);
		for (const [key, application] of this.#prepared) {
			if (
				controls.invalidateAll ||
				(controls.invalidatedPaths ?? []).some((file) =>
					application.dependencies.includes(file),
				)
			)
				this.#prepared.delete(key);
		}
	}

	async prepare(
		input: TestCompilationInput,
		compile: (input: TestCompilationInput) => Promise<PreparedTestApplication>,
	): Promise<PreparedTestApplication> {
		const key = JSON.stringify(input);
		const cached = this.#prepared.get(key);
		if (
			cached !== undefined &&
			cached.dependencyIdentities.every(frontendDependencyUnchanged)
		) {
			this.#used.add(JSON.stringify(cached.image));
			return {
				...cached,
				cache: "hit",
				frontendMs: 0,
				phases: {
					validationMs: 0,
					graphMs: 0,
					semanticMs: 0,
					compileMs: 0,
					serializeMs: 0,
					workerMs: 0,
				},
				artifactHits: cached.image.wires.length,
				artifactMisses: 0,
			};
		}
		const application = await compile(input);
		this.#prepared.set(key, application);
		this.#used.add(JSON.stringify(application.image));
		return application;
	}

	image(
		host: ApplicationImageHost,
		application: PreparedTestApplication,
	): ApplicationImage {
		const key = JSON.stringify(application.image);
		const existing = this.#images.get(key);
		if (existing !== undefined) return existing;
		const loaded = host.load(application.image);
		this.#images.set(key, loaded);
		return loaded;
	}

	finish(): void {
		for (const [key, image] of this.#images) {
			if (!this.#used.has(key)) {
				image.close();
				this.#images.delete(key);
			}
		}
		for (const [key, application] of this.#prepared) {
			if (!this.#used.has(JSON.stringify(application.image))) this.#prepared.delete(key);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const failures: Array<unknown> = [];
		for (const image of this.#images.values()) {
			try {
				image.close();
			} catch (error) {
				failures.push(error);
			}
		}
		this.#images.clear();
		this.#prepared.clear();
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, "test images could not be released");
	}
}
