import type { WorkerUrl } from "maligator:workers";
import type {
	ApplicationResources,
	NativeApplicationBridge,
} from "../../../src/application-images.ts";
export interface ApplicationData {
	mode: string;
	nested: Array<number>;
	gate: SharedArrayBuffer;
}
export interface ChildResult {
	generation: string;
	asset: string;
}
export interface ApplicationResult {
	generation: string;
	child: ChildResult;
	main: boolean;
	threadId: number;
	parentPort: unknown;
	workerData: unknown;
	argv: Array<string>;
	count: number;
	order: Array<string>;
	data: ApplicationData;
	resources: ApplicationResources;
	url: WorkerUrl;
}
export interface FixtureBridge extends NativeApplicationBridge {
	_applicationData(): unknown;
	_applicationResult(value: unknown): void;
	assets: { materialize(name: string): string };
}
export interface FixtureGlobals {
	launchCount?: number;
	fragmentOrder: Array<string>;
}
