import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export const ORIGIN = "https://studio-raum.test";

// Matches SETUP_PASSWORD in vitest.config.ts.
export const SETUP = {
  setupPassword: "test-setup-password",
  operatorName: "Linden Studios",
  operatorEmail: "owner@example.com",
  operatorAddress: "",
  operatorBusiness: false,
};

let addressCounter = 0;

export class Client {
  cookie: string | null = null;
  userId = "";
  readonly address: string;

  constructor(address?: string) {
    this.address = address ?? `203.0.113.${++addressCounter % 250}.${addressCounter}`;
  }

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": this.address };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie !== null) headers["Cookie"] = this.cookie;

    const response = await SELF.fetch(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0]!;
      this.cookie = pair.endsWith("=") ? null : pair;
    }
    return response;
  }

  async json<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    return (await response.json()) as T;
  }

  async ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    const payload = (await response.json()) as any;
    expect(response.ok, `${method} ${path} → ${response.status} ${JSON.stringify(payload)}`).toBe(true);
    return payload as T;
  }

  async failsWith(method: string, path: string, body?: unknown): Promise<string> {
    const response = await this.request(method, path, body);
    const payload = (await response.json()) as any;
    expect(response.ok, `${method} ${path} sollte scheitern, war aber ${response.status}`).toBe(false);
    return payload?.error?.code ?? "unbekannt";
  }

  hasCookie(): boolean {
    return this.cookie !== null;
  }
}

export interface Team {
  owner: Client;
  teamRef: string;
  personalSecret: string;
  joinSecret: string;
  studioId: string;
  studioIds: string[];
}

export async function createTeam(name = "Linden Studios", timeZone = "Europe/Berlin"): Promise<Team> {
  const owner = new Client();
  const created = await owner.ok("POST", "/api/team", { name, ownerName: "Jonas", timeZone, ...SETUP });
  const snapshot = await owner.ok("GET", "/api/snapshot");
  owner.userId = snapshot.currentUserId;
  const studioIds = [...snapshot.studios]
    .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
    .map((studio: any) => studio.id as string);
  return {
    owner,
    teamRef: created.teamRef,
    personalSecret: created.personalSecret,
    joinSecret: created.joinSecret,
    studioId: studioIds[0]!,
    studioIds,
  };
}

export async function joinApproved(team: Team, displayName: string): Promise<Client> {
  const client = new Client();
  await client.ok("POST", "/api/join", { joinSecret: team.joinSecret, displayName });

  const snapshot = await team.owner.ok("GET", "/api/snapshot");
  const pending = snapshot.members.find(
    (m: any) => m.displayName === displayName && m.isPending,
  );
  await team.owner.ok("POST", `/api/members/${pending.userId}/approve`);
  client.userId = pending.userId;
  return client;
}

export function slot(hoursFromBase = 0): number {
  const base = 1_800_000_000 - (1_800_000_000 % 900);
  return base + hoursFromBase * 3600;
}
