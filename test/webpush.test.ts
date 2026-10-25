import { describe, it, expect } from "vitest";
import {
  base64UrlToBytes, bytesToBase64Url, encryptPushPayload, isBase64UrlOfLength,
  vapidAuthorization, vapidConfigFrom,
} from "../worker/security/webpush";

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data as BufferSource));
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

async function browserSubscription() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  return { pair, publicKey, auth: crypto.getRandomValues(new Uint8Array(16)) };
}

describe("Push-Verschlüsselung", () => {
  it("liefert eine Nachricht, die der Browser wieder aufbekommt", async () => {
    const subscription = await browserSubscription();
    const payload = { title: "Studio A", body: "Max fragt 12:00 – 14:00 an.", vibrate: true };

    const body = await encryptPushPayload(
      encoder.encode(JSON.stringify(payload)), subscription.publicKey, subscription.auth,
    );

    const salt = body.slice(0, 16);
    const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
    const keyLength = body[20]!;
    const serverPublic = body.slice(21, 21 + keyLength);
    const ciphertext = body.slice(21 + keyLength);

    expect(recordSize).toBe(4096);
    expect(keyLength).toBe(65);

    const serverKey = await crypto.subtle.importKey(
      "raw", serverPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, [],
    );
    const shared = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      subscription.pair.privateKey, 256,
    ));

    const ikm = await hkdf(
      subscription.auth, shared,
      concat(encoder.encode("WebPush: info\0"), subscription.publicKey, serverPublic), 32,
    );
    const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

    const aesKey = await crypto.subtle.importKey(
      "raw", contentKey as BufferSource, { name: "AES-GCM" }, false, ["decrypt"],
    );
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource }, aesKey, ciphertext as BufferSource,
    ));

    expect(plain[plain.length - 1]).toBe(2);
    expect(JSON.parse(new TextDecoder().decode(plain.slice(0, -1)))).toEqual(payload);
  });

  it("erzeugt für jede Nachricht ein neues Salz", async () => {
    const subscription = await browserSubscription();
    const once = await encryptPushPayload(encoder.encode("a"), subscription.publicKey, subscription.auth);
    const twice = await encryptPushPayload(encoder.encode("a"), subscription.publicKey, subscription.auth);
    expect(bytesToBase64Url(once.slice(0, 16))).not.toBe(bytesToBase64Url(twice.slice(0, 16)));
  });
});

describe("VAPID", () => {
  async function vapidKeys() {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
    ) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
    return {
      publicKey: bytesToBase64Url(raw),
      privateKey: jwk.d!,
      subject: "mailto:info@tiborczekay.com",
      verifyKey: pair.publicKey,
    };
  }

  it("unterschreibt ein Token, das der Push-Dienst prüfen kann", async () => {
    const keys = await vapidKeys();
    const header = await vapidAuthorization(
      { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: keys.subject },
      "https://push.example.com/abo/12345?x=1",
    );

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    expect(match![2]).toBe(keys.publicKey);

    const [encodedHeader, encodedPayload, encodedSignature] = match![1]!.split(".");
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload!)));
    expect(claims.aud).toBe("https://push.example.com");
    expect(claims.sub).toBe(keys.subject);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, keys.verifyKey,
      base64UrlToBytes(encodedSignature!) as BufferSource,
      encoder.encode(`${encodedHeader}.${encodedPayload}`) as BufferSource,
    );
    expect(valid).toBe(true);
  });

  it("gilt ohne Schlüsselpaar als nicht eingerichtet", () => {
    expect(vapidConfigFrom({})).toBeNull();
    expect(vapidConfigFrom({ VAPID_PUBLIC_KEY: "abc" })).toBeNull();
    expect(vapidConfigFrom({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" })?.subject)
      .toBe("https://github.com/tibcz/studio-raum");
  });

  it("macht aus einer nackten Adresse ein mailto", () => {
    const paar = { VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" };
    expect(vapidConfigFrom({ ...paar, VAPID_SUBJECT: "owner@example.com" })?.subject)
      .toBe("mailto:owner@example.com");
    expect(vapidConfigFrom({ ...paar, VAPID_SUBJECT: "mailto:a@b.de" })?.subject)
      .toBe("mailto:a@b.de");
    expect(vapidConfigFrom({ ...paar, VAPID_SUBJECT: "https://studioraum.de" })?.subject)
      .toBe("https://studioraum.de");
  });
});

describe("Prüfung der Abonnementschlüssel", () => {
  it("nimmt nur base64url in der erwarteten Länge an", () => {
    expect(isBase64UrlOfLength(bytesToBase64Url(new Uint8Array(65)), 65)).toBe(true);
    expect(isBase64UrlOfLength(bytesToBase64Url(new Uint8Array(64)), 65)).toBe(false);
    expect(isBase64UrlOfLength("nicht base64!", 16)).toBe(false);
    expect(isBase64UrlOfLength(42, 16)).toBe(false);
    expect(isBase64UrlOfLength("", 16)).toBe(false);
  });
});
