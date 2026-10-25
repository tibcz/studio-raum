import { describe, it, expect } from "vitest";
import { Client, ORIGIN, createTeam, joinApproved, SETUP } from "./helpers";
import { SELF } from "cloudflare:test";

describe("Team anlegen", () => {
  it("liefert beide Geheimnisse und eine Sitzung", async () => {
    const team = await createTeam();

    expect(team.personalSecret).toMatch(/^SR1-/);
    expect(team.joinSecret).toMatch(/^SRJ1-/);
    expect(team.owner.hasCookie()).toBe(true);

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.team.name).toBe("Linden Studios");
    expect(snapshot.role).toBe("owner");
    expect(snapshot.studios.map((s: any) => s.name).sort()).toEqual(["Studio A", "Studio B", "Studio C"]);
  });

  it("macht die anlegende Person zum Besitzer", async () => {
    const team = await createTeam();
    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.members[0].role).toBe("owner");
    expect(snapshot.members[0].displayName).toBe("Jonas");
  });

  it("weist leere oder zu kurze Namen ab", async () => {
    const client = new Client();
    expect(await client.failsWith("POST", "/api/team", { name: "", ownerName: "Jonas", ...SETUP })).toBe("invalidText");
    expect(await client.failsWith("POST", "/api/team", { name: "X", ownerName: "Jonas", ...SETUP })).toBe("invalidText");
    expect(await client.failsWith("POST", "/api/team", { name: "Team", ownerName: "", ...SETUP })).toBe("invalidText");
  });
});

describe("Anmelden", () => {
  it("nimmt das persönliche Geheimnis in jeder Schreibweise an", async () => {
    const team = await createTeam();

    for (const variant of [
      team.personalSecret,
      team.personalSecret.toLowerCase(),
      team.personalSecret.replace(/-/g, ""),
      `  ${team.personalSecret}  `,
    ]) {
      const client = new Client();
      await client.ok("POST", "/api/session", { secret: variant });
      const snapshot = await client.ok("GET", "/api/snapshot");
      expect(snapshot.currentUserId).toBe(team.owner.userId);
    }
  });

  it("weist ein unbekanntes Geheimnis ab", async () => {
    const team = await createTeam();
    const fremd = `SR1-${team.teamRef}-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA`;
    const client = new Client();

    expect(await client.failsWith("POST", "/api/session", { secret: fremd })).toBe("invalidSecret");
    expect(client.hasCookie()).toBe(false);
  });

  it("weist Unsinn ab, ohne ein Durable Object zu bemühen", async () => {
    const client = new Client();
    for (const secret of ["", "hallo", "SR1-KURZ", null, 42, { a: 1 }]) {
      expect(await client.failsWith("POST", "/api/session", { secret })).toBe("invalidSecret");
    }
  });

  it("lässt ein Beitrittsgeheimnis nicht als Anmeldung durchgehen", async () => {
    const team = await createTeam();
    const client = new Client();
    expect(await client.failsWith("POST", "/api/session", { secret: team.joinSecret })).toBe("invalidSecret");
  });

  it("beendet die Sitzung beim Abmelden", async () => {
    const team = await createTeam();
    await team.owner.ok("DELETE", "/api/session");
    expect(await team.owner.failsWith("GET", "/api/snapshot")).toBe("notAuthenticated");
  });

  it("erneuert das persönliche Geheimnis und entwertet das alte", async () => {
    const team = await createTeam();
    const rotated = await team.owner.ok("POST", "/api/me/secret");

    expect(rotated.personalSecret).not.toBe(team.personalSecret);

    const mitAlt = new Client();
    expect(await mitAlt.failsWith("POST", "/api/session", { secret: team.personalSecret })).toBe("invalidSecret");

    const mitNeu = new Client();
    await mitNeu.ok("POST", "/api/session", { secret: rotated.personalSecret });
  });
});

describe("Beitreten", () => {
  it("landet im Warteraum und sieht bis zur Freigabe nichts", async () => {
    const team = await createTeam();
    const gast = new Client();
    const joined = await gast.ok("POST", "/api/join", { joinSecret: team.joinSecret, displayName: "Max" });

    expect(joined.status).toBe("pending");
    expect(joined.personalSecret).toMatch(/^SR1-/);
    expect(await gast.failsWith("GET", "/api/snapshot")).toBe("memberPending");
  });

  it("kann nach der Freigabe buchen", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");

    const snapshot = await max.ok("GET", "/api/snapshot");
    expect(snapshot.role).toBe("member");
    expect(snapshot.canWrite).toBe(true);
  });

  it("bleibt nach einer Ablehnung dauerhaft gesperrt", async () => {
    const team = await createTeam();
    const gast = new Client();
    await gast.ok("POST", "/api/join", { joinSecret: team.joinSecret, displayName: "Eve" });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const pending = snapshot.members.find((m: any) => m.displayName === "Eve");
    await team.owner.ok("POST", `/api/members/${pending.userId}/reject`);

    expect(await gast.failsWith("GET", "/api/snapshot")).toBe("notAuthenticated");
  });

  it("weist ein falsches Beitrittsgeheimnis ab", async () => {
    const team = await createTeam();
    const gast = new Client();
    const falsch = `SRJ1-${team.teamRef}-AAAAA-AAAAA-AAAAA-AAAAA`;
    expect(await gast.failsWith("POST", "/api/join", { joinSecret: falsch, displayName: "Eve" })).toBe("invalidSecret");
  });

  it("entwertet das alte Beitrittsgeheimnis beim Neuerzeugen", async () => {
    const team = await createTeam();
    const rotated = await team.owner.ok("POST", "/api/team/join-secret");

    const mitAlt = new Client();
    expect(await mitAlt.failsWith("POST", "/api/join", {
      joinSecret: team.joinSecret, displayName: "Max",
    })).toBe("invalidSecret");

    const mitNeu = new Client();
    const joined = await mitNeu.ok("POST", "/api/join", {
      joinSecret: rotated.joinSecret, displayName: "Max",
    });
    expect(joined.status).toBe("pending");
  });

  it("sperrt den Beitritt im Modus geschlossen", async () => {
    const team = await createTeam();
    await team.owner.ok("PATCH", "/api/team", {
      name: "Linden Studios", timeZone: "Europe/Berlin", joinMode: "closed",
    });

    const gast = new Client();
    expect(await gast.failsWith("POST", "/api/join", {
      joinSecret: team.joinSecret, displayName: "Max",
    })).toBe("joinClosed");
  });

  it("gibt im Modus ansehen Lesezugriff ohne Schreibrecht", async () => {
    const team = await createTeam();
    await team.owner.ok("PATCH", "/api/team", {
      name: "Linden Studios", timeZone: "Europe/Berlin", joinMode: "view",
    });

    const gast = new Client();
    const joined = await gast.ok("POST", "/api/join", {
      joinSecret: team.joinSecret, displayName: "Lena",
    });
    expect(joined.status).toBe("readOnly");

    const snapshot = await gast.ok("GET", "/api/snapshot");
    expect(snapshot.canWrite).toBe(false);
    expect(snapshot.studios.length).toBeGreaterThan(0);
  });
});

describe("Mandantentrennung", () => {
  it("erreicht mit dem Geheimnis des einen Teams nie das andere", async () => {
    const a = await createTeam("Team A");
    const b = await createTeam("Team B");

    expect(a.teamRef).not.toBe(b.teamRef);

    const snapshotA = await a.owner.ok("GET", "/api/snapshot");
    const snapshotB = await b.owner.ok("GET", "/api/snapshot");
    expect(snapshotA.team.name).toBe("Team A");
    expect(snapshotB.team.name).toBe("Team B");
    expect(snapshotA.team.id).not.toBe(snapshotB.team.id);

    const gast = new Client();
    await gast.ok("POST", "/api/join", { joinSecret: a.joinSecret, displayName: "Max" });
    const eintraege = (await a.owner.ok("GET", "/api/snapshot")).members;
    const eintraegeB = (await b.owner.ok("GET", "/api/snapshot")).members;
    expect(eintraege.some((m: any) => m.displayName === "Max")).toBe(true);
    expect(eintraegeB.some((m: any) => m.displayName === "Max")).toBe(false);
  });

  it("nimmt ein Cookie mit fremder Team-Referenz nicht an", async () => {
    const a = await createTeam("Team A");
    const b = await createTeam("Team B");

    const response = await SELF.fetch(`${ORIGIN}/api/snapshot`, {
      headers: { Cookie: `__Host-sr_session=${b.teamRef}.${"A".repeat(43)}` },
    });
    expect(response.status).toBe(401);
    expect(a.teamRef).not.toBe(b.teamRef);
  });
});
