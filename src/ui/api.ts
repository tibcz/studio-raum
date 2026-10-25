import type {
  Booking, BookingState, DayRequest, MemberPreferences, StandingRule, TeamMember, TeamSnapshot,
} from "../domain/models";

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// VITE_SR_DEMO=1 (the build for sr.tbor.app) shows a generated team and never talks to a server.
export const DEMO = import.meta.env.VITE_SR_DEMO === "1";

export const DEMO_MESSAGE = "This is a demo, so nothing can be changed or saved. Build your own Studio Raum to book rooms.";

let demoSnapshot: TeamSnapshot | null = null;

export function newDemoTeam(): void {
  demoSnapshot = null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (DEMO) {
    if (method === "GET" && path === "/api/snapshot") {
      const { generateDemoSnapshot } = await import("../demo/generate");
      demoSnapshot ??= generateDemoSnapshot();
      return demoSnapshot as T;
    }
    if (method === "GET" && path === "/api/export") return demoSnapshot as T;
    throw new ApiError("demo", DEMO_MESSAGE);
  }
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.error?.code ?? "network",
      payload?.error?.message ?? "The connection to the server failed.",
    );
  }
  return payload as T;
}

export interface StandingRuleInput {
  studioId: string;
  weekday: number;
  memberUserId: string;
  startMinute: number;
  endMinute: number;
  state: BookingState;
  title: string;
  isActive: boolean;
}

export interface Credentials {
  personalSecret: string;
  joinSecret?: string;
  status?: "active" | "pending" | "readOnly";
}

export interface OperatorInput {
  operatorName: string;
  operatorEmail: string;
  operatorAddress: string;
  operatorBusiness: boolean;
}

export interface InstanceInfo {
  setUp: boolean;
  open: boolean;
  operator: { name: string; email: string; address: string; business: boolean } | null;
}

// Filled once at start: who runs this copy, and whether it still needs its first team.
export let instanceInfo: InstanceInfo | null = null;

export async function loadInstanceInfo(): Promise<InstanceInfo | null> {
  if (DEMO) return null;
  try {
    instanceInfo = await call<InstanceInfo>("GET", "/api/instance");
  } catch {
    instanceInfo = null;
  }
  return instanceInfo;
}

export const api = {
  createTeam: (
    name: string, ownerName: string, timeZone: string, setupPassword: string, operator: OperatorInput | null,
  ) =>
    call<{ teamRef: string; personalSecret: string; joinSecret: string }>(
      "POST", "/api/team", { name, ownerName, timeZone, setupPassword, ...(operator ?? {}) },
    ),

  updateOperator: (operator: OperatorInput) => call<{ ok: true }>("PATCH", "/api/instance/operator", operator),

  join: (joinSecret: string, displayName: string) =>
    call<Credentials>("POST", "/api/join", { joinSecret, displayName }),

  login: (secret: string) => call<{ ok: true }>("POST", "/api/session", { secret }),
  logout: () => call<{ ok: true }>("DELETE", "/api/session"),

  snapshot: () => call<TeamSnapshot>("GET", "/api/snapshot"),
  exportData: () => call<unknown>("GET", "/api/export"),

  createBooking: (studioId: string, startTs: number, endTs: number, title: string, state: BookingState) =>
    call<Booking>("POST", "/api/bookings", { studioId, startTs, endTs, title, state }),
  updateBooking: (
    id: string, studioId: string, startTs: number, endTs: number, title: string, state: BookingState,
  ) => call<Booking>("PATCH", `/api/bookings/${id}`, { studioId, startTs, endTs, title, state }),
  setBookingState: (id: string, state: BookingState) =>
    call<Booking>("POST", `/api/bookings/${id}/state`, { state }),
  deleteBooking: (id: string) => call("DELETE", `/api/bookings/${id}`),

  releaseDays: (studioId: string, days: number[]) =>
    call<{ released: number; granted: number }>("POST", "/api/release", { studioId, days }),

  createRequest: (bookingId: string, startTs: number, endTs: number) =>
    call("POST", "/api/requests", { bookingId, startTs, endTs }),
  resolveRequest: (id: string, accept: boolean, keep = false) =>
    call("POST", `/api/requests/${id}/resolve`, { accept, keep }),
  cancelRequest: (id: string) => call("DELETE", `/api/requests/${id}`),

  createDayRequest: (startTs: number, endTs: number, studioId: string | null, note: string) =>
    call<DayRequest>("POST", "/api/day-requests", { startTs, endTs, studioId, note }),
  cancelDayRequest: (id: string) => call("DELETE", `/api/day-requests/${id}`),

  createStandingRule: (draft: StandingRuleInput) => call<StandingRule>("POST", "/api/standing", draft),
  updateStandingRule: (id: string, draft: StandingRuleInput) =>
    call<StandingRule>("PATCH", `/api/standing/${id}`, draft),
  deleteStandingRule: (id: string) => call("DELETE", `/api/standing/${id}`),

  updatePreferences: (patch: Partial<MemberPreferences>) =>
    call<MemberPreferences>("PATCH", "/api/preferences", patch),

  subscribePush: (subscription: { endpoint: string; p256dh: string; auth: string }) =>
    call("POST", "/api/push", subscription),
  unsubscribePush: (endpoint: string) => call("DELETE", "/api/push", { endpoint }),
  sendTestNotification: () => call<{ devices: number }>("POST", "/api/push/test"),
  markNotificationsRead: () => call("POST", "/api/notifications/read"),

  createStudio: (name: string, subtitle: string) =>
    call("POST", "/api/studios", { name, subtitle }),
  updateStudio: (id: string, patch: { name: string; subtitle: string; sortOrder: number; isActive: boolean }) =>
    call("PATCH", `/api/studios/${id}`, patch),

  updateMember: (id: string, patch: { displayName: string; role: string; isActive: boolean; canWrite: boolean }) =>
    call("PATCH", `/api/members/${id}`, patch),
  createPlaceholderMember: (displayName: string) =>
    call<TeamMember>("POST", "/api/members/placeholder", { displayName }),
  deletePlaceholderMember: (id: string) => call("DELETE", `/api/members/${id}`),
  approveMember: (id: string) => call("POST", `/api/members/${id}/approve`),
  rejectMember: (id: string) => call("POST", `/api/members/${id}/reject`),

  updateTeam: (name: string, timeZone: string, joinMode: string) =>
    call("PATCH", "/api/team", { name, timeZone, joinMode }),
  rotateJoinSecret: () => call<{ joinSecret: string }>("POST", "/api/team/join-secret"),
  rotatePersonalSecret: () => call<{ personalSecret: string }>("POST", "/api/me/secret"),
  deleteMyData: () => call<{ teamDeleted: boolean }>("DELETE", "/api/me"),
};
