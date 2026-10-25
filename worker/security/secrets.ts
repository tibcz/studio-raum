
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const TEAM_REF_LENGTH = 10;
const PERSONAL_GROUPS = 5;
const JOIN_GROUPS = 4;
const GROUP_LENGTH = 5;

const PERSONAL_PREFIX = "SR1";
const JOIN_PREFIX = "SRJ1";

function randomChars(count: number): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % 32];
  return out;
}

function grouped(groups: number): string {
  return Array.from({ length: groups }, () => randomChars(GROUP_LENGTH)).join("-");
}

export function newTeamRef(): string {
  return randomChars(TEAM_REF_LENGTH);
}

export function newPersonalSecret(teamRef: string): string {
  return `${PERSONAL_PREFIX}-${teamRef}-${grouped(PERSONAL_GROUPS)}`;
}

export function newJoinSecret(teamRef: string): string {
  return `${JOIN_PREFIX}-${teamRef}-${grouped(JOIN_GROUPS)}`;
}

export interface ParsedSecret {
  kind: "personal" | "join";
  teamRef: string;
  body: string;
  canonical: string;
}

export function parseSecret(input: unknown): ParsedSecret | null {
  if (typeof input !== "string" || input.length > 128) return null;

  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");

  let kind: ParsedSecret["kind"];
  let rest: string;
  let bodyLength: number;

  if (cleaned.startsWith(JOIN_PREFIX)) {
    kind = "join";
    rest = cleaned.slice(JOIN_PREFIX.length);
    bodyLength = JOIN_GROUPS * GROUP_LENGTH;
  } else if (cleaned.startsWith(PERSONAL_PREFIX)) {
    kind = "personal";
    rest = cleaned.slice(PERSONAL_PREFIX.length);
    bodyLength = PERSONAL_GROUPS * GROUP_LENGTH;
  } else {
    return null;
  }

  if (rest.length !== TEAM_REF_LENGTH + bodyLength) return null;
  for (const char of rest) {
    if (!ALPHABET.includes(char)) return null;
  }

  const teamRef = rest.slice(0, TEAM_REF_LENGTH);
  const body = rest.slice(TEAM_REF_LENGTH);
  const prefix = kind === "join" ? JOIN_PREFIX : PERSONAL_PREFIX;
  return { kind, teamRef, body, canonical: `${prefix}${teamRef}${body}` };
}

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(pepper: string): Promise<CryptoKey> {
  let cached = keyCache.get(pepper);
  if (!cached) {
    cached = crypto.subtle.importKey(
      "raw",
      encoder.encode(pepper),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(pepper, cached);
  }
  return cached;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashSecret(pepper: string, secret: string): Promise<string> {
  const canonical = parseSecret(secret)?.canonical ?? secret;
  const key = await hmacKey(pepper);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)));
}

export async function hashToken(pepper: string, token: string): Promise<string> {
  const key = await hmacKey(pepper);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(token)));
}

export function newSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newId(): string {
  return crypto.randomUUID();
}

export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
  }
  return diff === 0;
}
