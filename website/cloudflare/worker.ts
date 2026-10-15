import { Container } from "@cloudflare/containers";

interface Environment {
	MALIGATOR_SITE: {
		getByName(name: string): { fetch(request: Request): Promise<Response> };
	};
}

export class MaligatorSite extends Container {
	override defaultPort = 3000;
	override sleepAfter = "10m";
}

// oxlint-disable-next-line import/no-default-export -- Workers require a default fetch handler.
export default {
	fetch(request: Request, environment: Environment): Promise<Response> {
		// The existing instance name preserves the single production container's identity.
		return environment.MALIGATOR_SITE.getByName("website-alpha-25").fetch(request);
	},
};
