import { StudioRaumError } from "../../src/domain/errors";

export const SESSION_COOKIE = "__Host-sr_session";

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), interest-cohort=()",
  };
}

export function withSecurityHeaders(response: Response): Response {
  if (response.status === 101 || response.webSocket) return response;

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof StudioRaumError) {
    return json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  console.error("Unhandled error:", error);
  return json(
    { error: { code: "internal", message: "Unexpected error. Please try again." } },
    { status: 500 },
  );
}

export function assertSameOrigin(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("Origin");
  if (origin === null) throw new StudioRaumError("badRequest", "The request origin is missing.");
  if (origin !== new URL(request.url).origin) {
    throw new StudioRaumError("permissionDenied", "The request origin is not allowed.");
  }
}

export async function readJsonBody(request: Request, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maximumBytes) throw new StudioRaumError("badRequest", "The request is too large.");

  const text = await request.text();
  if (text.length > maximumBytes) throw new StudioRaumError("badRequest", "The request is too large.");
  if (text.length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StudioRaumError("badRequest");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StudioRaumError) throw error;
    throw new StudioRaumError("badRequest", "The request was not valid JSON.");
  }
}
