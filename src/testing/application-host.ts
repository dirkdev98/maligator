import type {
	ApplicationImageDescriptor,
	ApplicationInstance,
	ApplicationLaunchOptions,
	ApplicationResources,
} from "../application-images.ts";
import type { FrontendDependencyIdentity } from "../frontend-cache.ts";

export interface NativeTestInputs {
	identity: string;
	dependencies: Array<FrontendDependencyIdentity>;
}

export type TestApplication = Pick<
	ApplicationInstance,
	"ready" | "applicationReady" | "closed" | "terminate"
>;

export interface TestApplicationImage {
	launch(options: ApplicationLaunchOptions): TestApplication;
	close(): void;
}

/** Test execution needs lifecycle and result delivery from a local or linked host. */
export interface TestApplicationHost {
	readonly native?: NativeTestInputs;
	load(descriptor: ApplicationImageDescriptor): TestApplicationImage;
	resources?(): ApplicationResources;
	close?(): void | Promise<void>;
}
