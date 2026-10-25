
export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  gone: boolean;
}

const encoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function isBase64UrlOfLength(value: unknown, length: number): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (!/^[A-Za-z0-9_-]+=*$/.test(value)) return false;
  try {
    return base64UrlToBytes(value).length === length;
  } catch {
    return false;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data as BufferSource));
}

async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const output = await hmac(prk, concat(info, new Uint8Array([1])));
  return output.slice(0, length);
}

async function importVapidKey(config: VapidConfig): Promise<CryptoKey> {
  const publicBytes = base64UrlToBytes(config.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 point.");
  }
  const privateBytes = base64UrlToBytes(config.privateKey);
  if (privateBytes.length !== 32) {
    throw new Error("VAPID_PRIVATE_KEY is not a 32-byte scalar.");
  }

  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(publicBytes.slice(1, 33)),
      y: bytesToBase64Url(publicBytes.slice(33, 65)),
      d: bytesToBase64Url(privateBytes),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function vapidAuthorization(config: VapidConfig, endpoint: string): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: config.subject,
  })));

  const signingInput = `${header}.${payload}`;
  const key = await importVapidKey(config);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signingInput),
  ));

  return `vapid t=${signingInput}.${bytesToBase64Url(signature)}, k=${config.publicKey}`;
}

const RECORD_SIZE = 4096;

export async function encryptPushPayload(
  plaintext: Uint8Array, clientPublic: Uint8Array, authSecret: Uint8Array,
): Promise<Uint8Array> {
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const serverPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey) as ArrayBuffer,
  );

  const clientKey = await crypto.subtle.importKey(
    "raw", clientPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const deriveAlgorithm = { name: "ECDH", public: clientKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(deriveAlgorithm, ephemeral.privateKey, 256),
  );

  const keyInfo = concat(
    encoder.encode("WebPush: info\0"), clientPublic, serverPublic,
  );
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey(
    "raw", contentKey as BufferSource, { name: "AES-GCM" }, false, ["encrypt"],
  );
  const padded = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource }, aesKey, padded as BufferSource,
  ));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);

  return concat(salt, recordSize, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

export async function sendPush(
  config: VapidConfig,
  subscription: PushSubscriptionKeys,
  payload: unknown,
  ttlSeconds = 12 * 60 * 60,
): Promise<PushResult> {
  const body = await encryptPushPayload(
    encoder.encode(JSON.stringify(payload)),
    base64UrlToBytes(subscription.p256dh),
    base64UrlToBytes(subscription.auth),
  );

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
      TTL: String(ttlSeconds),
      Urgency: "high",
      Authorization: await vapidAuthorization(config, subscription.endpoint),
    },
    body: body as BodyInit,
  });

  return {
    ok: response.ok,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
  };
}

export function vapidConfigFrom(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: normalizedSubject(env.VAPID_SUBJECT) };
}

function normalizedSubject(value: string | undefined): string {
  const subject = value?.trim();
  if (!subject) return "https://github.com/tibcz/studio-raum";
  if (/^(mailto:|https:\/\/)/i.test(subject)) return subject;
  return `mailto:${subject}`;
}
