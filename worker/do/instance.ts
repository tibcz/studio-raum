import { DurableObject } from "cloudflare:workers";

// One object per copy of Studio Raum ("instance"). It holds what belongs to the copy rather than to a
// team: the secrets the server needs, the details of whoever runs the copy, and which teams exist.
// A self-hosted copy needs no secrets configured: the first request generates them here.

export interface Operator {
  name: string;
  email: string;
  address: string;
  business: boolean;
}

export interface InstanceSecrets {
  pepper: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
}

export interface InstanceStatus {
  setUp: boolean;
  open: boolean;
  operator: Operator | null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function newSecrets(): Promise<InstanceSecrets> {
  const pepper = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
  const x = fromBase64Url(jwk.x!);
  const y = fromBase64Url(jwk.y!);
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 33);
  return { pepper, vapidPublicKey: base64Url(point), vapidPrivateKey: jwk.d! };
}

export class InstanceDO extends DurableObject {
  async secrets(): Promise<InstanceSecrets> {
    const stored = await this.ctx.storage.get<InstanceSecrets>("secrets");
    if (stored) return stored;
    const created = await newSecrets();
    await this.ctx.storage.put("secrets", created);
    return created;
  }

  async status(maxTeams: number): Promise<InstanceStatus> {
    const teams = (await this.ctx.storage.get<string[]>("teams")) ?? [];
    const operator = (await this.ctx.storage.get<Operator>("operator")) ?? null;
    return { setUp: teams.length > 0 && operator !== null, open: teams.length < maxTeams, operator };
  }

  // Reserves a place for a new team. Returns false when the copy already holds as many teams as allowed.
  async claim(teamRef: string, maxTeams: number, operator: Operator | null): Promise<boolean> {
    const teams = (await this.ctx.storage.get<string[]>("teams")) ?? [];
    if (teams.length >= maxTeams) return false;
    teams.push(teamRef);
    await this.ctx.storage.put("teams", teams);
    if (operator !== null && teams.length === 1) await this.ctx.storage.put("operator", operator);
    return true;
  }

  async release(teamRef: string): Promise<void> {
    const teams = ((await this.ctx.storage.get<string[]>("teams")) ?? []).filter((ref) => ref !== teamRef);
    await this.ctx.storage.put("teams", teams);
    if (teams.length === 0) await this.ctx.storage.delete("operator");
  }

  async updateOperator(operator: Operator): Promise<void> {
    await this.ctx.storage.put("operator", operator);
  }
}
