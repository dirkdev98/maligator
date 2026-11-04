import type {
	ApplicationExit,
	ApplicationImageDescriptor,
	ApplicationLaunchOptions,
	ApplicationResources,
} from "../application-images.ts";

export type TestHostOperation =
	| { kind: "ping" }
	| { kind: "load"; image: number; descriptor: ApplicationImageDescriptor }
	| {
			kind: "launch";
			image: number;
			application: number;
			options: ApplicationLaunchOptions;
	  }
	| { kind: "release"; image: number }
	| { kind: "terminate"; application: number }
	| { kind: "close" };

export type TestHostRequest = TestHostOperation & { id: number };

export interface TestHostError {
	name: string;
	message: string;
	stack?: string;
}

export type TestHostExit = Omit<ApplicationExit, "error"> & { error?: TestHostError };

export type TestHostEvent =
	| { kind: "reply"; id: number; error?: TestHostError }
	| { kind: "ready" | "application-ready"; application: number; error?: TestHostError }
	| { kind: "closed"; application: number; exit: TestHostExit };

export type TestHostMessage = TestHostEvent & { resources: ApplicationResources };

export function testHostError(error: unknown): TestHostError {
	return error instanceof Error
		? {
				name: error.name,
				message: error.message,
				...(error.stack === undefined ? {} : { stack: error.stack }),
			}
		: { name: "Error", message: String(error) };
}

export function restoreTestHostError(error: TestHostError): Error {
	const restored = new Error(error.message);
	restored.name = error.name;
	if (error.stack !== undefined) restored.stack = error.stack;
	return restored;
}
