import { StudioRaumError, decodeErrorFromRpc } from "../../src/domain/errors";
import type { BookingState, JoinMode, MemberRole } from "../../src/domain/models";
import { TEXT_LIMITS, requiredText, sanitizedText } from "../../src/domain/sanitize";
import { ALPHABET, hashToken, newTeamRef, parseSecret, timingSafeEqual } from "../security/secrets";
import {
  SESSION_COOKIE, assertSameOrigin, clearedSessionCookie, errorResponse, json,
  readCookie, readJsonBody, sessionCookie,
} from "../security/http";
import { serverKeys, type BookingDraft, type Env, type StandingRuleDraft, type StudioTeamDO } from "../do/team";
import type { Operator } from "../do/instance";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

interface Session {
  teamRef: string;
  userId: string;
  stub: DurableObjectStub<StudioTeamDO>;
}

function parseSessionCookie(value: string | null): { teamRef: string; token: string } | null {
  if (value === null) return null;
  const separator = value.indexOf(".");
  if (separator < 0) return null;

  const teamRef = value.slice(0, separator);
  const token = value.slice(separator + 1);
  if (teamRef.length !== 10 || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  for (const char of teamRef) if (!ALPHABET.includes(char)) return null;
  return { teamRef, token };
}

function stubFor(env: Env, teamRef: string): DurableObjectStub<StudioTeamDO> {
  return env.TEAM.getByName(`team:${teamRef}`);
}

async function clientKey(request: Request, env: Env): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return hashToken((await serverKeys(env)).pepper, `client:${address}`);
}

export function maxTeams(env: Env): number {
  const value = Number(env.MAX_TEAMS ?? "1");
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

function instanceOf(env: Env) {
  return env.INSTANCE.getByName("instance");
}

function operatorFrom(body: Record<string, unknown>): Operator {
  const email = sanitizedText(body.operatorEmail, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new StudioRaumError("invalidText", "Please enter an email address people can reach you at.");
  }
  const business = body.operatorBusiness === true;
  const address = typeof body.operatorAddress === "string"
    ? body.operatorAddress.split(/\r?\n/).map((line) => sanitizedText(line, 120)).filter(Boolean).slice(0, 6).join("\n")
    : "";
  if (business && address.trim().length < 8) {
    throw new StudioRaumError("invalidText", "For business use, the legal notice needs your postal address.");
  }
  return {
    name: requiredText(body.operatorName, TEXT_LIMITS.teamName, 2),
    email,
    address,
    business,
  };
}

async function checkSetupPassword(env: Env, given: unknown): Promise<void> {
  const expected = env.SETUP_PASSWORD?.trim() ?? "";
  if (expected.length === 0) throw new StudioRaumError("setupMissing");
  const ok = typeof given === "string" && timingSafeEqual(given.trim(), expected);
  if (!ok) throw new StudioRaumError("setupPassword");
}

async function currentSession(request: Request, env: Env): Promise<Session | null> {
  const parsed = parseSessionCookie(readCookie(request, SESSION_COOKIE));
  if (!parsed) return null;

  const stub = stubFor(env, parsed.teamRef);
  const resolved = await stub.resolveSession(parsed.token);
  if (!resolved) return null;
  return { teamRef: parsed.teamRef, userId: resolved.userId, stub };
}

async function requireSession(request: Request, env: Env): Promise<Session> {
  const session = await currentSession(request, env);
  if (!session) throw new StudioRaumError("notAuthenticated");
  return session;
}

function bookingDraft(body: Record<string, unknown>): BookingDraft {
  return {
    studioId: String(body.studioId ?? ""),
    startTs: Number(body.startTs),
    endTs: Number(body.endTs),
    title: sanitizedText(body.title, TEXT_LIMITS.title),
    ...(body.state === undefined ? {} : { state: body.state as BookingState }),
  };
}

function standingDraft(body: Record<string, unknown>): StandingRuleDraft {
  return {
    studioId: String(body.studioId ?? ""),
    weekday: Number(body.weekday),
    memberUserId: String(body.memberUserId ?? ""),
    startMinute: Number(body.startMinute),
    endMinute: Number(body.endMinute),
    state: (body.state === "occupied" ? "occupied" : "reserved") as BookingState,
    title: sanitizedText(body.title, TEXT_LIMITS.title),
    isActive: body.isActive !== false,
  };
}

function setSession(response: Response, teamRef: string, token: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", sessionCookie(`${teamRef}.${token}`, SESSION_MAX_AGE));
  return new Response(response.body, { status: response.status, headers });
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  try {
    assertSameOrigin(request);
    return await route(request, env, path);
  } catch (error) {
    return errorResponse(decodeErrorFromRpc(error));
  }
}

async function route(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;

  if (path === "/api/instance" && method === "GET") {
    const status = await instanceOf(env).status(maxTeams(env));
    return json({
      setUp: status.setUp,
      open: status.open,
      // The same details the public legal notice shows.
      operator: status.operator,
    });
  }

  if (path === "/api/team" && method === "POST") {
    const gate = env.RATE_GATE.getByName(`team-create:${await clientKey(request, env)}`);
    if (!(await gate.allow(5, 3600))) throw new StudioRaumError("rateLimited");

    const body = await readJsonBody(request);
    await checkSetupPassword(env, body.setupPassword);
    const name = requiredText(body.name, TEXT_LIMITS.teamName, 2);
    const ownerName = requiredText(body.ownerName, TEXT_LIMITS.displayName, 2);
    const instance = instanceOf(env);
    const first = !(await instance.status(maxTeams(env))).setUp;
    const operator = first ? operatorFrom(body) : null;

    const teamRef = newTeamRef();
    if (!(await instance.claim(teamRef, maxTeams(env), operator))) throw new StudioRaumError("instanceFull");
    let created;
    try {
      created = await stubFor(env, teamRef).createTeam({
        teamRef, name, ownerName, timeZone: String(body.timeZone ?? "Europe/Berlin"),
      });
    } catch (error) {
      await instance.release(teamRef);
      throw error;
    }
    return setSession(
      json({
        teamRef: created.teamRef,
        personalSecret: created.personalSecret,
        joinSecret: created.joinSecret,
      }, { status: 201 }),
      created.teamRef, created.sessionToken,
    );
  }

  if (path === "/api/join" && method === "POST") {
    const body = await readJsonBody(request);
    const parsed = parseSecret(body.joinSecret);
    if (!parsed || parsed.kind !== "join") throw new StudioRaumError("invalidSecret");

    const result = await stubFor(env, parsed.teamRef).join(
      parsed.canonical,
      requiredText(body.displayName, TEXT_LIMITS.displayName, 2),
      await clientKey(request, env),
    );
    return setSession(
      json({ personalSecret: result.personalSecret, status: result.status }, { status: 201 }),
      parsed.teamRef, result.sessionToken,
    );
  }

  if (path === "/api/session" && method === "POST") {
    const body = await readJsonBody(request);
    const parsed = parseSecret(body.secret);
    if (!parsed || parsed.kind !== "personal") throw new StudioRaumError("invalidSecret");

    const opened = await stubFor(env, parsed.teamRef)
      .openSession(parsed.canonical, await clientKey(request, env));
    return setSession(json({ ok: true }), parsed.teamRef, opened.sessionToken);
  }

  if (path === "/api/session" && method === "DELETE") {
    const parsed = parseSessionCookie(readCookie(request, SESSION_COOKIE));
    if (parsed) await stubFor(env, parsed.teamRef).closeSession(parsed.token);
    const response = json({ ok: true });
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", clearedSessionCookie());
    return new Response(response.body, { status: 200, headers });
  }

  const session = await requireSession(request, env);
  const { stub, userId } = session;

  if (path === "/api/snapshot" && method === "GET") {
    return json(await stub.snapshot(userId));
  }

  if (path === "/api/instance/operator" && method === "PATCH") {
    const snapshot = await stub.snapshot(userId);
    if (snapshot.role !== "owner") throw new StudioRaumError("permissionDenied");
    const body = await readJsonBody(request);
    const operator = operatorFrom(body);
    await instanceOf(env).updateOperator(operator);
    return json({ ok: true });
  }

  if (path === "/api/export" && method === "GET") {
    return json(await stub.exportData(userId));
  }

  if (path === "/api/bookings" && method === "POST") {
    return json(await stub.createBooking(userId, bookingDraft(await readJsonBody(request))), { status: 201 });
  }

  const bookingMatch = /^\/api\/bookings\/([A-Za-z0-9-]{1,64})(\/state)?$/.exec(path);
  if (bookingMatch) {
    const bookingId = bookingMatch[1]!;
    if (bookingMatch[2] && method === "POST") {
      const body = await readJsonBody(request);
      return json(await stub.setBookingState(userId, bookingId, body.state as BookingState));
    }
    if (!bookingMatch[2] && method === "PATCH") {
      return json(await stub.updateBooking(userId, bookingId, bookingDraft(await readJsonBody(request))));
    }
    if (!bookingMatch[2] && method === "DELETE") {
      await stub.deleteBooking(userId, bookingId);
      return json({ ok: true });
    }
  }

  if (path === "/api/release" && method === "POST") {
    const body = await readJsonBody(request);
    const days = Array.isArray(body.days) ? body.days.map((value) => Number(value)) : [];
    return json(await stub.releaseDays(userId, String(body.studioId ?? ""), days));
  }

  if (path === "/api/requests" && method === "POST") {
    const body = await readJsonBody(request);
    return json(
      await stub.createRequest(userId, String(body.bookingId ?? ""), Number(body.startTs), Number(body.endTs)),
      { status: 201 },
    );
  }

  const requestMatch = /^\/api\/requests\/([A-Za-z0-9-]{1,64})(\/resolve)?$/.exec(path);
  if (requestMatch) {
    const requestId = requestMatch[1]!;
    if (requestMatch[2] && method === "POST") {
      const body = await readJsonBody(request);
      await stub.resolveRequest(userId, requestId, body.accept === true, body.keep === true);
      return json({ ok: true });
    }
    if (!requestMatch[2] && method === "DELETE") {
      await stub.cancelRequest(userId, requestId);
      return json({ ok: true });
    }
  }

  if (path === "/api/day-requests" && method === "POST") {
    const body = await readJsonBody(request);
    return json(await stub.createDayRequest(userId, {
      startTs: Number(body.startTs),
      endTs: Number(body.endTs),
      studioId: typeof body.studioId === "string" && body.studioId.length > 0 ? body.studioId : null,
      note: sanitizedText(body.note, TEXT_LIMITS.title),
    }), { status: 201 });
  }

  const dayRequestMatch = /^\/api\/day-requests\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (dayRequestMatch && method === "DELETE") {
    await stub.cancelDayRequest(userId, dayRequestMatch[1]!);
    return json({ ok: true });
  }

  if (path === "/api/standing" && method === "POST") {
    return json(await stub.createStandingRule(userId, standingDraft(await readJsonBody(request))), { status: 201 });
  }

  const standingMatch = /^\/api\/standing\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (standingMatch) {
    const ruleId = standingMatch[1]!;
    if (method === "PATCH") {
      return json(await stub.updateStandingRule(userId, ruleId, standingDraft(await readJsonBody(request))));
    }
    if (method === "DELETE") {
      await stub.deleteStandingRule(userId, ruleId);
      return json({ ok: true });
    }
  }

  if (path === "/api/preferences" && method === "PATCH") {
    const body = await readJsonBody(request);
    return json(await stub.updatePreferences(userId, {
      ...(typeof body.notifyEnabled === "boolean" ? { notifyEnabled: body.notifyEnabled } : {}),
      ...(typeof body.notifyVibrate === "boolean" ? { notifyVibrate: body.notifyVibrate } : {}),
      ...(Array.isArray(body.studioPriority)
        ? { studioPriority: body.studioPriority.filter((id): id is string => typeof id === "string") }
        : {}),
    }));
  }

  if (path === "/api/push" && method === "POST") {
    const body = await readJsonBody(request);
    await stub.savePushSubscription(userId, {
      endpoint: String(body.endpoint ?? ""),
      p256dh: String(body.p256dh ?? ""),
      auth: String(body.auth ?? ""),
    });
    return json({ ok: true }, { status: 201 });
  }

  if (path === "/api/push" && method === "DELETE") {
    const body = await readJsonBody(request);
    await stub.deletePushSubscription(userId, String(body.endpoint ?? ""));
    return json({ ok: true });
  }

  if (path === "/api/push/test" && method === "POST") {
    return json(await stub.sendTestNotification(userId));
  }

  if (path === "/api/notifications/read" && method === "POST") {
    await stub.markNotificationsRead(userId);
    return json({ ok: true });
  }

  if (path === "/api/studios" && method === "POST") {
    const body = await readJsonBody(request);
    return json(
      await stub.createStudio(userId, String(body.name ?? ""), String(body.subtitle ?? "")),
      { status: 201 },
    );
  }

  const studioMatch = /^\/api\/studios\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (studioMatch && method === "PATCH") {
    const body = await readJsonBody(request);
    return json(await stub.updateStudio(userId, studioMatch[1]!, {
      name: String(body.name ?? ""),
      subtitle: String(body.subtitle ?? ""),
      sortOrder: Number(body.sortOrder ?? 0),
      isActive: body.isActive !== false,
    }));
  }

  if (path === "/api/members/placeholder" && method === "POST") {
    const body = await readJsonBody(request);
    return json(
      await stub.createPlaceholderMember(userId, requiredText(body.displayName, TEXT_LIMITS.displayName, 2)),
      { status: 201 },
    );
  }

  const memberMatch = /^\/api\/members\/([A-Za-z0-9-]{1,64})(\/approve|\/reject)?$/.exec(path);
  if (memberMatch) {
    const memberId = memberMatch[1]!;
    if (memberMatch[2] === "/approve" && method === "POST") {
      await stub.setMemberApproval(userId, memberId, true);
      return json({ ok: true });
    }
    if (memberMatch[2] === "/reject" && method === "POST") {
      await stub.setMemberApproval(userId, memberId, false);
      return json({ ok: true });
    }
    if (!memberMatch[2] && method === "DELETE") {
      await stub.deletePlaceholderMember(userId, memberId);
      return json({ ok: true });
    }
    if (!memberMatch[2] && method === "PATCH") {
      const body = await readJsonBody(request);
      await stub.updateMember(userId, memberId, {
        displayName: String(body.displayName ?? ""),
        role: String(body.role ?? "member") as MemberRole,
        isActive: body.isActive !== false,
        canWrite: body.canWrite !== false,
      });
      return json({ ok: true });
    }
  }

  if (path === "/api/team" && method === "PATCH") {
    const body = await readJsonBody(request);
    await stub.updateTeam(userId, {
      name: String(body.name ?? ""),
      timeZone: String(body.timeZone ?? ""),
      joinMode: String(body.joinMode ?? "approval") as JoinMode,
    });
    return json({ ok: true });
  }

  if (path === "/api/team/join-secret" && method === "POST") {
    return json(await stub.rotateJoinSecret(userId));
  }

  if (path === "/api/me/secret" && method === "POST") {
    const rotated = await stub.rotatePersonalSecret(userId);
    return setSession(
      json({ personalSecret: rotated.personalSecret }),
      session.teamRef, rotated.sessionToken,
    );
  }

  if (path === "/api/me" && method === "DELETE") {
    const result = await stub.deleteMyData(userId);
    if (result.teamDeleted) await instanceOf(env).release(session.teamRef);
    const response = json(result);
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", clearedSessionCookie());
    return new Response(response.body, { status: 200, headers });
  }

  if (path === "/api/events" && method === "GET") {
    if (request.headers.get("Upgrade") !== "websocket") {
      throw new StudioRaumError("badRequest", "A WebSocket connection is expected.");
    }
    return stub.fetch(new Request("https://team.internal/events", {
      headers: { Upgrade: "websocket" },
    }));
  }

  throw new StudioRaumError("notFound");
}
