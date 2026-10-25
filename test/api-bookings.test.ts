import { describe, it, expect } from "vitest";
import { createTeam, joinApproved, slot, type Team } from "./helpers";

async function book(team: Team, client = team.owner, from = 10, to = 12, title = "") {
  return client.ok("POST", "/api/bookings", {
    studioId: team.studioId, startTs: slot(from), endTs: slot(to), title,
  });
}

describe("Buchen", () => {
  it("legt eine Buchung mit Notiz an", async () => {
    const team = await createTeam();
    const booking = await book(team, team.owner, 10, 12, "Recording");

    expect(booking.startTs).toBe(slot(10));
    expect(booking.endTs).toBe(slot(12));
    expect(booking.title).toBe("Recording");
    expect(booking.ownerUserId).toBe(team.owner.userId);

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.bookings).toHaveLength(1);
  });

  it("weist Zeiten außerhalb des Rasters ab", async () => {
    const team = await createTeam();
    expect(await team.owner.failsWith("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10) + 60, endTs: slot(12), title: "",
    })).toBe("invalidTime");
  });

  it("weist Zeiträume über 24 Stunden ab", async () => {
    const team = await createTeam();
    expect(await team.owner.failsWith("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(0), endTs: slot(25), title: "",
    })).toBe("invalidTime");
  });

  it("weist ein unbekanntes Studio ab", async () => {
    const team = await createTeam();
    expect(await team.owner.failsWith("POST", "/api/bookings", {
      studioId: "gibt-es-nicht", startTs: slot(10), endTs: slot(12), title: "",
    })).toBe("studioUnavailable");
  });
});

describe("Doppelbelegung", () => {
  it("lehnt eine überlappende Buchung ab", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    await book(team, team.owner, 10, 14);

    for (const [from, to] of [[10, 12], [12, 16], [9, 11], [11, 13], [8, 20]]) {
      expect(await max.failsWith("POST", "/api/bookings", {
        studioId: team.studioId, startTs: slot(from), endTs: slot(to), title: "",
      }), `${from}-${to}`).toBe("bookingConflict");
    }
  });

  it("lässt anschließende Zeiträume zu", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    await book(team, team.owner, 10, 12);

    await book(team, max, 12, 14);
    await book(team, max, 8, 10);

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.bookings).toHaveLength(3);
  });

  it("hält die Studios auseinander", async () => {
    const team = await createTeam();
    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const zweites = snapshot.studios.find((s: any) => s.id !== team.studioId);

    await book(team, team.owner, 10, 12);
    await team.owner.ok("POST", "/api/bookings", {
      studioId: zweites.id, startTs: slot(10), endTs: slot(12), title: "",
    });

    expect((await team.owner.ok("GET", "/api/snapshot")).bookings).toHaveLength(2);
  });

  it("lässt bei gleichzeitigen Versuchen genau einen gewinnen", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const lena = await joinApproved(team, "Lena");

    const body = { studioId: team.studioId, startTs: slot(10), endTs: slot(12), title: "" };
    const responses = await Promise.all([
      team.owner.request("POST", "/api/bookings", body),
      max.request("POST", "/api/bookings", body),
      lena.request("POST", "/api/bookings", body),
    ]);

    expect(responses.filter((r) => r.ok)).toHaveLength(1);
    expect((await team.owner.ok("GET", "/api/snapshot")).bookings).toHaveLength(1);
  });

  it("gibt den Zeitraum nach dem Löschen wieder frei", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const booking = await book(team, team.owner, 10, 12);

    expect(await max.failsWith("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(12), title: "",
    })).toBe("bookingConflict");

    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);
    await book(team, max, 10, 12);
  });
});

describe("Buchung ändern", () => {
  it("verschiebt den Zeitraum und gibt die alten Slots frei", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const booking = await book(team, team.owner, 10, 12);

    await team.owner.ok("PATCH", `/api/bookings/${booking.id}`, {
      studioId: team.studioId, startTs: slot(14), endTs: slot(16), title: "Verschoben",
    });

    await book(team, max, 10, 12);
    expect(await max.failsWith("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(14), endTs: slot(16), title: "",
    })).toBe("bookingConflict");
  });

  it("verlängert in einen freien Zeitraum hinein", async () => {
    const team = await createTeam();
    const booking = await book(team, team.owner, 10, 12);

    const updated = await team.owner.ok("PATCH", `/api/bookings/${booking.id}`, {
      studioId: team.studioId, startTs: slot(10), endTs: slot(16), title: "",
    });
    expect(updated.endTs).toBe(slot(16));
  });

  it("lehnt eine Verlängerung in einen belegten Zeitraum ab", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const booking = await book(team, team.owner, 10, 12);
    await book(team, max, 14, 16);

    expect(await team.owner.failsWith("PATCH", `/api/bookings/${booking.id}`, {
      studioId: team.studioId, startTs: slot(10), endTs: slot(16), title: "",
    })).toBe("bookingConflict");

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const unveraendert = snapshot.bookings.find((b: any) => b.id === booking.id);
    expect(unveraendert.endTs).toBe(slot(12));
    expect(snapshot.bookings).toHaveLength(2);
  });

  it("wechselt das Studio und tauscht alle Locks", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    const zweites = snapshot.studios.find((s: any) => s.id !== team.studioId);
    const booking = await book(team, team.owner, 10, 12);

    await team.owner.ok("PATCH", `/api/bookings/${booking.id}`, {
      studioId: zweites.id, startTs: slot(10), endTs: slot(12), title: "",
    });

    await book(team, max, 10, 12);
    expect(await max.failsWith("POST", "/api/bookings", {
      studioId: zweites.id, startTs: slot(10), endTs: slot(12), title: "",
    })).toBe("bookingConflict");
  });

  it("lässt fremde Buchungen nicht ändern oder löschen", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const booking = await book(team, team.owner, 10, 12);

    expect(await max.failsWith("PATCH", `/api/bookings/${booking.id}`, {
      studioId: team.studioId, startTs: slot(10), endTs: slot(11), title: "",
    })).toBe("permissionDenied");
    expect(await max.failsWith("DELETE", `/api/bookings/${booking.id}`)).toBe("permissionDenied");
  });

  it("lässt einen Admin auch fremde Buchungen verwalten", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const booking = await book(team, max, 10, 12);

    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);
    expect((await team.owner.ok("GET", "/api/snapshot")).bookings).toHaveLength(0);
  });
});
