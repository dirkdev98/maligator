// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Runtime lifecycle notifications for supervised applications. Module evaluation and
 * application readiness are separate events; readiness means the application has
 * finished its own startup work.
 */
declare module "maligator:application" {
	/**
	 * Notify the development supervisor that this application is ready. Repeated calls
	 * are harmless. Returns true in a supervised application and false in a standalone
	 * application or ordinary worker. Call after resources such as a server listener are
	 * accepting work; this does not reserve ports or transfer traffic.
	 *
	 * @example
	 * import { ready } from "maligator:application";
	 * import { createServer } from "node:http";
	 *
	 * createServer((_request, response) => response.end("hello")).listen(3000, () => ready());
	 */
	export const ready: () => boolean;
}
