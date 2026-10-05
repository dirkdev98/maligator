import { readFileSync } from "node:fs";

export type SitePage = "overview" | "explorer" | "api" | "compatibility";

const navigation = [
	{ page: "overview", href: "/", label: "Overview" },
	{ page: "explorer", href: "/explorer", label: "Explorer" },
	{ page: "api", href: "/docs", label: "Docs" },
	{ page: "compatibility", href: "/compatibility", label: "Compatibility" },
	{ page: "github", href: "https://github.com/dirkdev98/maligator", label: "GitHub" },
] as const;

export function renderSiteTemplate(template: string, page: SitePage): string {
	const mascot = readFileSync(new URL("../mascot.webp", import.meta.url)).toString(
		"base64",
	);
	const { version } = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	) as { version: string };
	const escapedVersion = version.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
	const links = navigation
		.map((link) => {
			const current =
				link.page === page
					? ` aria-current="${page === "api" ? "location" : "page"}"`
					: "";
			return `<a href="${link.href}"${current}>${link.label}</a>`;
		})
		.join("\n");
	const regions = {
		__SITE_ICONS__: `<link rel="icon" href="/favicon.ico" type="image/vnd.microsoft.icon" sizes="16x16 32x32 48x48 256x256">
<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">`,
		__SITE_STYLES__:
			page === "explorer"
				? ""
				: `<style>${readFileSync(new URL("shared.css", import.meta.url), "utf8")}</style>`,
		__SITE_NAVIGATION__: `<div class="site-navigation"><header class="site-header">
<a class="wordmark" href="/" aria-label="Maligator home"><img class="nav-mascot" src="data:image/webp;base64,${mascot}" alt="" width="768" height="768">maligator</a>
<nav aria-label="Primary navigation">${links}</nav>
</header></div>`,
		__SITE_FOOTER__: `<footer class="site-footer">
<span${page === "explorer" ? ' class="version" id="version"' : ""}>Maligator <span data-version>${escapedVersion}</span></span>
<span>Self-contained. No analytics.</span>
${page === "explorer" ? '<a href="__LICENSES__">Open-source licenses</a>' : ""}
</footer>`,
	};
	for (const [token, content] of Object.entries(regions)) {
		if (!template.includes(token))
			throw new Error(`Missing site template token: ${token}`);
		template = template.replaceAll(token, content);
	}
	return template;
}
