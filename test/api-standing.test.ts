import { describe, it, expect } from "vitest";
import { createTeam, joinApproved, type Team } from "./helpers";
import { weekdayOf } from "../src/domain/time";

const ZONE = "Europe/Berlin";

function kommenderWochentag(): number {
  const heute = weekdayOf(Math.floor(Date.now() / 1000), ZONE);
  return (heute + 2) % 7;
}

function serientermine(snapshot: any, ruleId?: string) {
  return snapshot.bookings
    .filter((b: any) => b.origin === "standing" && (ruleId === undefined || b.standingRuleId === ruleId))
    .sort((a: any, b: any) => a.startTs - b.startTs);
}

async function regel(team: Team, patch: Record<string, unknown> = {}) {
  return team.owner.ok("POST", "/api/standing", {
    studioId: team.studioId,
    weekday: kommenderWochentag(),
    memberUserId: team.owner.userId,
    startMinute: 0,
    endMinute: 1440,
    state: "reserved",
    title: "Stammzeit",
    ...patch,
  });
}

describe("Standardbelegung anlegen", () => {
  it("schreibt die Reihe in die kommenden acht Wochen", async () => {
    const team = await createTeam();
    const rule = await regel(team);
    expect(rule.state).toBe("reserved");

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const termine = serientermine(snapshot, rule.id);

    expect(termine.length).toBeGreaterThanOrEqual(8);
    for (const termin of termine) {
      expect(weekdayOf(termin.startTs, ZONE)).toBe(rule.weekday);
      expect(termin.ownerUserId).toBe(team.owner.userId);
      expect(termin.state).toBe("reserved");
      expect(termin.title).toBe("Stammzeit");
    }
  });

  it("hält sich an das gewählte Zeitfenster", async () => {
    const team = await createTeam();
    const rule = await regel(team, { startMinute: 14 * 60, endMinute: 22 * 60 });

    const termine = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id);
    for (const termin of termine) {
      expect(termin.endTs - termin.startTs).toBe(8 * 3600);
    }
  });

  it("lässt zwei Personen sich denselben Tag teilen", async () => {
    const team = await createTeam();
    const fly = await joinApproved(team, "Fly");
    const tag = kommenderWochentag();

    await regel(team, { weekday: tag, startMinute: 0, endMinute: 14 * 60 });
    await regel(team, {
      weekday: tag, startMinute: 14 * 60, endMinute: 1440, memberUserId: fly.userId,
    });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.standingRules).toHaveLength(2);
    const besitzer = new Set(serientermine(snapshot).map((b: any) => b.ownerUserId));
    expect(besitzer).toEqual(new Set([team.owner.userId, fly.userId]));
  });

  it("weist eine Überschneidung im selben Raum am selben Tag ab", async () => {
    const team = await createTeam();
    const tag = kommenderWochentag();
    await regel(team, { weekday: tag, startMinute: 0, endMinute: 14 * 60 });

    expect(await team.owner.failsWith("POST", "/api/standing", {
      studioId: team.studioId, weekday: tag, memberUserId: team.owner.userId,
      startMinute: 12 * 60, endMinute: 20 * 60, state: "reserved", title: "",
    })).toBe("standingConflict");
  });

  it("besteht auf halben Stunden", async () => {
    const team = await createTeam();
    expect(await team.owner.failsWith("POST", "/api/standing", {
      studioId: team.studioId, weekday: 1, memberUserId: team.owner.userId,
      startMinute: 615, endMinute: 1080, state: "reserved", title: "",
    })).toBe("invalidTime");
  });

  it("bleibt einem einfachen Mitglied verwehrt", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    expect(await max.failsWith("POST", "/api/standing", {
      studioId: team.studioId, weekday: 1, memberUserId: max.userId,
      startMinute: 0, endMinute: 1440, state: "reserved", title: "",
    })).toBe("permissionDenied");
  });
});

describe("Einzelne Tage herauslösen", () => {
  it("legt einen gelöschten Serientermin nicht wieder an", async () => {
    const team = await createTeam();
    const rule = await regel(team);

    const vorher = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id);
    const geloescht = vorher[0];
    await team.owner.ok("DELETE", `/api/bookings/${geloescht.id}`);

    await regel(team, { studioId: team.studioIds[1] });

    const nachher = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id);
    expect(nachher.map((b: any) => b.startTs)).not.toContain(geloescht.startTs);
    expect(nachher).toHaveLength(vorher.length - 1);
  });

  it("gibt den Raum an diesem Tag für alle frei", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const rule = await regel(team);
    const termin = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id)[0];

    expect(await max.failsWith("POST", "/api/bookings", {
      studioId: team.studioId, startTs: termin.startTs, endTs: termin.startTs + 3600, title: "",
    })).toBe("bookingConflict");

    await team.owner.ok("DELETE", `/api/bookings/${termin.id}`);
    await max.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: termin.startTs, endTs: termin.startTs + 3600, title: "",
    });
  });

  it("lässt zwei Buchungen an einem Tag zu", async () => {
    const team = await createTeam();
    const fly = await joinApproved(team, "Fly");
    const rule = await regel(team);
    const termin = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id)[0];

    await team.owner.ok("PATCH", `/api/bookings/${termin.id}`, {
      studioId: team.studioId,
      startTs: termin.startTs + 18 * 3600,
      endTs: termin.startTs + 24 * 3600,
      title: "Abends",
    });
    await fly.ok("POST", "/api/bookings", {
      studioId: team.studioId,
      startTs: termin.startTs + 14 * 3600,
      endTs: termin.startTs + 18 * 3600,
      title: "Ab 14 Uhr",
    });

    const amTag = (await team.owner.ok("GET", "/api/snapshot")).bookings
      .filter((b: any) => b.studioId === team.studioId
        && b.startTs >= termin.startTs && b.startTs < termin.startTs + 86400);
    expect(amTag).toHaveLength(2);
  });
});

describe("Standardbelegung ändern und entfernen", () => {
  it("schreibt kommende Tage nach einer Änderung neu", async () => {
    const team = await createTeam();
    const rule = await regel(team, { startMinute: 0, endMinute: 1440 });

    await team.owner.ok("PATCH", `/api/standing/${rule.id}`, {
      studioId: team.studioId, weekday: rule.weekday, memberUserId: team.owner.userId,
      startMinute: 10 * 60, endMinute: 14 * 60, state: "occupied", title: "Kurz",
    });

    const termine = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id);
    expect(termine.length).toBeGreaterThanOrEqual(8);
    for (const termin of termine) {
      expect(termin.endTs - termin.startTs).toBe(4 * 3600);
      expect(termin.state).toBe("occupied");
    }
  });

  it("gibt beim Entfernen alle kommenden Termine frei", async () => {
    const team = await createTeam();
    const rule = await regel(team);
    expect(serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id).length)
      .toBeGreaterThan(0);

    await team.owner.ok("DELETE", `/api/standing/${rule.id}`);

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.standingRules).toHaveLength(0);
    expect(serientermine(snapshot, rule.id)).toHaveLength(0);
  });

  it("nimmt keine Standardbelegung für ein gesperrtes Mitglied an", async () => {
    const team = await createTeam();
    const fly = await joinApproved(team, "Fly");
    await team.owner.ok("PATCH", `/api/members/${fly.userId}`, {
      displayName: "Fly", role: "member", isActive: false, canWrite: true,
    });

    expect(await team.owner.failsWith("POST", "/api/standing", {
      studioId: team.studioId, weekday: kommenderWochentag(), memberUserId: fly.userId,
      startMinute: 0, endMinute: 1440, state: "reserved", title: "",
    })).toBe("badRequest");
  });

  it("lässt eine Reihe nach der Sperre ihres Mitglieds nicht mehr ändern", async () => {
    const team = await createTeam();
    const fly = await joinApproved(team, "Fly");
    const rule = await regel(team, { memberUserId: fly.userId });
    const vorher = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id);
    expect(vorher.length).toBeGreaterThan(0);

    await team.owner.ok("PATCH", `/api/members/${fly.userId}`, {
      displayName: "Fly", role: "member", isActive: false, canWrite: true,
    });

    const nachher = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id);
    expect(nachher).toHaveLength(vorher.length);
    expect(await team.owner.failsWith("PATCH", `/api/standing/${rule.id}`, {
      studioId: team.studioId, weekday: rule.weekday, memberUserId: fly.userId,
      startMinute: 0, endMinute: 720, state: "reserved", title: "",
    })).toBe("badRequest");

    await team.owner.ok("DELETE", `/api/standing/${rule.id}`);
    expect(serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id)).toHaveLength(0);
  });
});

describe("Serientermine im Zusammenspiel", () => {
  it("lässt sich anfragen, weil sie geblockt sind", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const rule = await regel(team);
    const termin = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id)[0];

    const request = await max.ok("POST", "/api/requests", {
      bookingId: termin.id,
      startTs: termin.startTs + 10 * 3600,
      endTs: termin.startTs + 14 * 3600,
    });
    expect(request.status).toBe("pending");
  });

  it("kehrt nach einer Übergabe nicht zurück", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const rule = await regel(team);
    const termin = serientermine(await team.owner.ok("GET", "/api/snapshot"), rule.id)[0];

    const request = await max.ok("POST", "/api/requests", {
      bookingId: termin.id, startTs: termin.startTs, endTs: termin.endTs,
    });
    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: true });

    await regel(team, { studioId: team.studioIds[1] });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const uebergeben = snapshot.bookings.find((b: any) => b.id === termin.id);
    expect(uebergeben.ownerUserId).toBe(max.userId);
    expect(uebergeben.origin).toBe("manual");
    expect(serientermine(snapshot, rule.id).map((b: any) => b.startTs))
      .not.toContain(termin.startTs);
  });
});
