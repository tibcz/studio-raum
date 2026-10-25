import { SELF, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../worker/api/router";
import type { Env } from "../worker/do/team";

const env = testEnv as unknown as Env;
import { Client, ORIGIN, SETUP, createTeam } from "./helpers";

// A self-hosted copy: setup password, the operator's details on the legal pages, one team by default.

describe("Einrichtung einer Kopie", () => {
  it("verlangt das Einrichtungspasswort", async () => {
    const client = new Client();
    const body = { name: "Linden Studios", ownerName: "Jonas", ...SETUP };
    expect(await client.failsWith("POST", "/api/team", { ...body, setupPassword: "wrong" })).toBe("setupPassword");
    expect(await client.failsWith("POST", "/api/team", { ...body, setupPassword: undefined })).toBe("setupPassword");
  });

  it("verlangt beim ersten Team eine erreichbare E-Mail-Adresse", async () => {
    const client = new Client();
    const body = { name: "Linden Studios", ownerName: "Jonas", ...SETUP, operatorEmail: "nobody" };
    expect(await client.failsWith("POST", "/api/team", body)).toBe("invalidText");
  });

  it("verlangt bei geschäftlicher Nutzung eine Anschrift", async () => {
    const client = new Client();
    const body = { name: "Linden Studios", ownerName: "Jonas", ...SETUP, operatorBusiness: true, operatorAddress: "" };
    expect(await client.failsWith("POST", "/api/team", body)).toBe("invalidText");
  });

  it("zeigt die Angaben des Betreibers in Impressum und Datenschutzerklärung", async () => {
    const owner = new Client();
    await owner.ok("POST", "/api/team", {
      name: "Linden Studios", ownerName: "Jonas", ...SETUP,
      operatorName: "Linden Studios GbR", operatorBusiness: true, operatorAddress: "Musterweg 1\n12345 Musterstadt",
    });
    const status = await owner.ok("GET", "/api/instance");
    expect(status.setUp).toBe(true);
    expect(status.operator.name).toBe("Linden Studios GbR");

    const legal = await (await SELF.fetch(`${ORIGIN}/legal`)).text();
    expect(legal).toContain("Linden Studios GbR");
    expect(legal).toContain("Musterweg 1<br>12345 Musterstadt");
    expect(legal).toContain("§ 5 DDG");
    const privacy = await SELF.fetch(`${ORIGIN}/privacy`);
    expect(privacy.headers.get("Content-Security-Policy")).toContain("style-src 'self'");
    expect(await privacy.text()).toContain("owner@example.com");
  });

  it("entfernt HTML aus den Angaben", async () => {
    const team = await createTeam();
    await team.owner.ok("PATCH", "/api/instance/operator", {
      operatorName: "<script>x</script>Linden", operatorEmail: "owner@example.com", operatorAddress: "", operatorBusiness: false,
    });
    const legal = await (await SELF.fetch(`${ORIGIN}/legal`)).text();
    expect(legal).not.toContain("<script>x");
    expect(legal).toContain("&lt;script&gt;");
  });

  it("nimmt ohne MAX_TEAMS nur ein einziges Team auf", async () => {
    const single = { ...env, MAX_TEAMS: undefined };
    const post = (address: string) => handleApi(new Request(`${ORIGIN}/api/team`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": address },
      body: JSON.stringify({ name: "Linden Studios", ownerName: "Jonas", ...SETUP }),
    }), single, "/api/team");

    const first = await post("198.51.100.1");
    const firstBody = await first.json() as any;
    const status = await env.INSTANCE.getByName("instance").status(1);
    if (status.open) expect(first.status, JSON.stringify(firstBody)).toBe(201);
    const second = await post("198.51.100.2");
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error.code).toBe("instanceFull");
  });

  it("gibt den Platz frei, wenn der Besitzer das Team löscht", async () => {
    const team = await createTeam();
    const before = await env.INSTANCE.getByName("instance").status(1000);
    await team.owner.ok("DELETE", "/api/me");
    const after = await env.INSTANCE.getByName("instance").status(1000);
    expect(after.open).toBe(true);
    expect(before.operator).not.toBeNull();
  });

  it("darf die Betreiberangaben nur der Besitzer ändern", async () => {
    const team = await createTeam();
    const update = { operatorName: "Neu", operatorEmail: "neu@example.com", operatorAddress: "", operatorBusiness: false };
    await team.owner.ok("PATCH", "/api/instance/operator", update);
    const status = await team.owner.ok("GET", "/api/instance");
    expect(status.operator.email).toBe("neu@example.com");
  });

  it("erzeugt seine Schlüssel selbst und behält sie", async () => {
    const instance = env.INSTANCE.getByName("schluessel-test");
    const first = await instance.secrets();
    const again = await instance.secrets();
    expect(again).toEqual(first);
    expect(first.pepper.length).toBeGreaterThanOrEqual(43);
    const point = Uint8Array.from(atob(first.vapidPublicKey.replaceAll("-", "+").replaceAll("_", "/") + "="), (c) => c.charCodeAt(0));
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
    const key = await crypto.subtle.importKey("jwk", {
      kty: "EC", crv: "P-256", d: first.vapidPrivateKey,
      x: first.vapidPublicKey.length ? btoa(String.fromCharCode(...point.slice(1, 33))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : "",
      y: btoa(String.fromCharCode(...point.slice(33))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    expect(key.type).toBe("private");
  });
});
