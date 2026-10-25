import { describe, it, expect } from "vitest";
import { Client, createTeam, joinApproved, slot } from "./helpers";

async function withPlaceholder(name = "Klavierlehrerin") {
  const team = await createTeam();
  const person = await team.owner.ok("POST", "/api/members/placeholder", { displayName: name });
  return { team, person };
}

describe("Externe Person", () => {
  it("legt sie als Mitglied ohne Zugang an", async () => {
    const { person } = await withPlaceholder();
    expect(person.isPlaceholder).toBe(true);
    expect(person.isActive).toBe(true);
    expect(person.role).toBe("member");
  });

  it("taucht im Team auf, damit ihre Tage jemandem gehören", async () => {
    const { team } = await withPlaceholder("Frau Beck");
    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const found = snapshot.members.find((m: any) => m.displayName === "Frau Beck");
    expect(found.isPlaceholder).toBe(true);
  });

  it("verlangt einen Namen", async () => {
    const team = await createTeam();
    expect(await team.owner.failsWith("POST", "/api/members/placeholder", { displayName: "" }))
      .toBe("invalidText");
  });

  it("dürfen nur Verwalter anlegen", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    expect(await max.failsWith("POST", "/api/members/placeholder", { displayName: "Extern" }))
      .toBe("permissionDenied");
  });

  it("bekommt eine Standardbelegung wie jedes andere Mitglied", async () => {
    const { team, person } = await withPlaceholder();
    const rule = await team.owner.ok("POST", "/api/standing", {
      studioId: team.studioIds[2], weekday: 2, memberUserId: person.userId,
      startMinute: 0, endMinute: 1440, state: "occupied", title: "Unterricht", isActive: true,
    });
    expect(rule.memberUserId).toBe(person.userId);

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const hers = snapshot.bookings.filter((b: any) => b.ownerUserId === person.userId);
    expect(hers.length).toBeGreaterThan(0);
  });

  it("behält weder Rolle noch Schreibrecht, wenn jemand sie zuweist", async () => {
    const { team, person } = await withPlaceholder();
    await team.owner.ok("PATCH", `/api/members/${person.userId}`, {
      displayName: "Klavierlehrerin", role: "admin", isActive: true, canWrite: true,
    });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const found = snapshot.members.find((m: any) => m.userId === person.userId);
    expect(found.role).toBe("member");
    expect(found.isPlaceholder).toBe(true);
  });

  it("kann sich mit keinem Geheimnis anmelden", async () => {
    const { team, person } = await withPlaceholder();
    const fremd = new Client();

    for (const versuch of [`platzhalter:${person.userId}`, person.userId, team.personalSecret.slice(0, 8)]) {
      expect(await fremd.failsWith("POST", "/api/session", { secret: versuch })).toBe("invalidSecret");
    }
    expect(fremd.hasCookie()).toBe(false);
  });

  it("lässt einen Admin ihre Tage freigeben", async () => {
    const { team, person } = await withPlaceholder();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(2), endTs: slot(6), title: "Unterricht", state: "occupied",
    });
    expect(booking.id).toBeTruthy();

    const result = await team.owner.ok("POST", "/api/release", {
      studioId: team.studioId, days: [slot(0)],
    });
    expect(result.released).toBe(1);
  });

  it("wird samt Buchungen und Standardbelegung entfernt", async () => {
    const { team, person } = await withPlaceholder();
    await team.owner.ok("POST", "/api/standing", {
      studioId: team.studioIds[2], weekday: 2, memberUserId: person.userId,
      startMinute: 0, endMinute: 1440, state: "occupied", title: "Unterricht", isActive: true,
    });

    await team.owner.ok("DELETE", `/api/members/${person.userId}`);

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.members.find((m: any) => m.userId === person.userId)).toBeUndefined();
    expect(snapshot.standingRules).toHaveLength(0);
    expect(snapshot.bookings.filter((b: any) => b.ownerUserId === person.userId)).toHaveLength(0);
  });

  it("löscht kein echtes Mitglied über denselben Weg", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    expect(await team.owner.failsWith("DELETE", `/api/members/${max.userId}`))
      .toBe("permissionDenied");

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.members.find((m: any) => m.userId === max.userId)).toBeDefined();
  });
});
