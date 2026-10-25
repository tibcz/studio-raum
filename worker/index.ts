import { handleApi, maxTeams } from "./api/router";
import { withSecurityHeaders } from "./security/http";
import { legalNoticePage, privacyPage } from "./legal";
import type { Env } from "./do/team";

export { StudioTeamDO } from "./do/team";
export { RateGateDO } from "./do/rate-gate";
export { InstanceDO } from "./do/instance";
export type { Env };

// Date of the legal texts in worker/legal.ts. Change it whenever those texts change.
const LEGAL_DATE = "25.10.2026";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && (pathname === "/privacy" || pathname === "/legal")) {
      const { operator } = await env.INSTANCE.getByName("instance").status(maxTeams(env));
      const html = pathname === "/privacy" ? privacyPage(operator, LEGAL_DATE) : legalNoticePage(operator, LEGAL_DATE);
      const response = withSecurityHeaders(new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      }));
      // The pages load /legal.css and the icon from this origin, nothing else.
      response.headers.set("Content-Security-Policy",
        "default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      return response;
    }
    return withSecurityHeaders(await handleApi(request, env, pathname));
  },
} satisfies ExportedHandler<Env>;
