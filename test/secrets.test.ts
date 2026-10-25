import { describe, it, expect } from "vitest";
import {
  ALPHABET,
  newTeamRef,
  newPersonalSecret,
  newJoinSecret,
  parseSecret,
  hashSecret,
  timingSafeEqual,
  newSessionToken,
} from "../worker/security/secrets";

const PEPPER = "pepper-für-den-test";

describe("Geheimnisse", () => {
  it("verwendet ein Alphabet ohne verwechselbare Zeichen", () => {
    expect(ALPHABET).toHaveLength(32);
    for (const forbidden of ["I", "L", "O", "U"]) {
      expect(ALPHABET).not.toContain(forbidden);
    }
  });

  it("erzeugt persönliche Geheimnisse im vereinbarten Format", () => {
    const teamRef = newTeamRef();
    const secret = newPersonalSecret(teamRef);

    expect(secret).toMatch(/^SR1-[0-9A-Z]{10}(-[0-9A-Z]{5}){5}$/);
    const parsed = parseSecret(secret);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("personal");
    expect(parsed!.teamRef).toBe(teamRef);
    expect(parsed!.body).toHaveLength(25);
  });

  it("erzeugt Beitrittsgeheimnisse im vereinbarten Format", () => {
    const teamRef = newTeamRef();
    const secret = newJoinSecret(teamRef);

    expect(secret).toMatch(/^SRJ1-[0-9A-Z]{10}(-[0-9A-Z]{5}){4}$/);
    const parsed = parseSecret(secret);
    expect(parsed!.kind).toBe("join");
    expect(parsed!.teamRef).toBe(teamRef);
    expect(parsed!.body).toHaveLength(20);
  });

  it("hält persönliches und Beitrittsgeheimnis auseinander", () => {
    const teamRef = newTeamRef();
    expect(parseSecret(newPersonalSecret(teamRef))!.kind).toBe("personal");
    expect(parseSecret(newJoinSecret(teamRef))!.kind).toBe("join");
  });

  it("wiederholt sich nicht", () => {
    const teamRef = newTeamRef();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(newPersonalSecret(teamRef));
    expect(seen.size).toBe(500);
    expect(new Set(Array.from({ length: 500 }, newTeamRef)).size).toBe(500);
  });

  it("verzeiht Abschreibfehler nach den Crockford-Regeln", () => {
    const secret = "SR1-7K2P9XQV3N-WT8FD-Z6HJR-B2YXM-4KP0W-7NGQ4";
    const canonical = parseSecret(secret)!;

    for (const variant of [
      secret.toLowerCase(),
      `  ${secret}  `,
      secret.replace(/-/g, ""),
      secret.replace(/-/g, " "),
      secret.replace("1", "I").replace("0", "O"),
    ]) {
      const parsed = parseSecret(variant);
      expect(parsed, variant).not.toBeNull();
      expect(parsed!.body).toBe(canonical.body);
      expect(parsed!.teamRef).toBe(canonical.teamRef);
    }
  });

  it("weist alles ab, was nicht dem Format entspricht", () => {
    for (const invalid of [
      "", "SR1", "SR1-", "hallo", "SR2-7K2P9XQV3N-WT8FD-Z6HJR-B2YXM-4KP0W-7NGQ4",
      "SR1-7K2P9XQV3N-WT8FD-Z6HJR-B2YXM-4KP0W", // zu kurz
      "SR1-7K2P9XQV3N-WT8FD-Z6HJR-B2YXM-4KP0W-7NGQ4-EXTRA", // zu lang
      "SR1-7K2P9XQV3N-WT8FD-Z6HJR-B2YXM-4KP0W-7NGQ!", // ungültiges Zeichen
      "SR1-7K2P9XQV3N-WT8FD-Z6HJR-B2YXM-4KP0W-7NGQU", // U ist nicht im Alphabet
      "A".repeat(5000),
      null, undefined, 42, {},
    ] as unknown[]) {
      expect(parseSecret(invalid as string), String(invalid)).toBeNull();
    }
  });

  it("hasht mit dem Pepper und ist reproduzierbar", async () => {
    const secret = newPersonalSecret(newTeamRef());
    const first = await hashSecret(PEPPER, secret);
    const second = await hashSecret(PEPPER, secret);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain(secret);
  });

  it("liefert ohne den Pepper einen anderen Hash", async () => {
    const secret = newPersonalSecret(newTeamRef());
    expect(await hashSecret(PEPPER, secret)).not.toBe(await hashSecret("anderer-pepper", secret));
  });

  it("hasht die kanonische Form, nicht die Schreibweise", async () => {
    const secret = "SR1-7K2P9XQV3N-WT8FD-Z6HJR-B2YXM-4KP0W-7NGQ4";
    expect(await hashSecret(PEPPER, secret.toLowerCase())).toBe(await hashSecret(PEPPER, secret));
    expect(await hashSecret(PEPPER, secret.replace(/-/g, ""))).toBe(await hashSecret(PEPPER, secret));
  });

  it("vergleicht in konstanter Zeit und ohne Fehlurteil", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("erzeugt Session-Token mit 256 Bit", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 500 }, newSessionToken)).size).toBe(500);
  });
});
