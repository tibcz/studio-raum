import { describe, it, expect } from "vitest";
import { Client, createTeam, joinApproved, slot, type Team } from "./helpers";

function bookingsOf(snapshot: any, userId: string) {
  return snapshot.bookings
    .filter((b: any) => b.ownerUserId === userId)
    .sort((a: any, b: any) => a.startTs - b.startTs);
}

function kinds(snapshot: any): string[] {
  return snapshot.notifications.map((n: any) => n.kind);
}

async function setup() {
  const team = await createTeam();
  const max = await joinApproved(team, "Max");
  const booking = await team.owner.ok("POST", "/api/bookings", {
    studioId: team.studioId, startTs: slot(10), endTs: slot(18),
    title: "Session", state: "reserved",
  });
  return { team, max, booking };
}

describe("Warteschlange beim Freigeben", () => {
  it("trägt die anfragende Person ein, statt die Anfrage abzubrechen", async () => {
    const { team, max, booking } = await setup();
    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);

    const snapshot = await max.ok("GET", "/api/snapshot");
    const mine = bookingsOf(snapshot, max.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0].startTs).toBe(slot(12));
    expect(mine[0].endTs).toBe(slot(14));
    expect(mine[0].state).toBe("occupied");
    expect(bookingsOf(snapshot, team.owner.userId)).toHaveLength(0);
  });

  it("meldet der aufgerückten Person, dass der Raum ihr gehört", async () => {
    const { team, max, booking } = await setup();
    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);

    expect(kinds(await max.ok("GET", "/api/snapshot"))).toContain("requestAccepted");
  });

  it("lässt die älteste Anfrage zuerst aufrücken", async () => {
    const { team, max, booking } = await setup();
    const lena = await joinApproved(team, "Lena");

    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    await lena.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);

    const snapshot = await max.ok("GET", "/api/snapshot");
    expect(bookingsOf(snapshot, max.userId)).toHaveLength(1);
    expect(bookingsOf(snapshot, lena.userId)).toHaveLength(0);
  });

  it("sagt den leer Ausgegangenen, dass der Raum frei geworden ist", async () => {
    const { team, max, booking } = await setup();
    const lena = await joinApproved(team, "Lena");
    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    await lena.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);

    const notes = kinds(await lena.ok("GET", "/api/snapshot"));
    expect(notes).toContain("slotReleased");
    expect(notes).not.toContain("requestDeclined");
  });

  it("bedient zwei Anfragen auf verschiedene Stunden desselben Tages", async () => {
    const { team, max, booking } = await setup();
    const lena = await joinApproved(team, "Lena");

    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(10), endTs: slot(12),
    });
    await lena.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);

    const snapshot = await max.ok("GET", "/api/snapshot");
    expect(bookingsOf(snapshot, max.userId)).toHaveLength(1);
    expect(bookingsOf(snapshot, lena.userId)).toHaveLength(1);
    expect(bookingsOf(snapshot, team.owner.userId)).toHaveLength(0);
  });

  it("löscht ohne offene Anfrage wie bisher", async () => {
    const { team, booking } = await setup();
    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);
    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.bookings).toHaveLength(0);
  });

  it("meldet dem Besitzer, wenn ein Admin seine Buchung freigibt", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const booking = await max.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "Mix", state: "occupied",
    });

    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);

    expect(kinds(await max.ok("GET", "/api/snapshot"))).toContain("bookingReleasedByAdmin");
  });
});

describe("Mehrere Tage freigeben", () => {
  const DAY = 24 * 3600;

  async function threeDays(): Promise<{ team: Team; owner: Client; ids: string[] }> {
    const team = await createTeam();
    const ids: string[] = [];
    for (const offset of [0, 1, 2]) {
      const created = await team.owner.ok("POST", "/api/bookings", {
        studioId: team.studioId,
        startTs: slot(2) + offset * DAY,
        endTs: slot(6) + offset * DAY,
        title: "Urlaub", state: "occupied",
      });
      ids.push(created.id);
    }
    return { team, owner: team.owner, ids };
  }

  it("gibt nicht zusammenhängende Tage in einem Zug frei", async () => {
    const { team, owner } = await threeDays();

    const result = await owner.ok("POST", "/api/release", {
      studioId: team.studioId,
      days: [slot(0), slot(0) + 2 * DAY],
    });

    expect(result.released).toBe(2);
    const snapshot = await owner.ok("GET", "/api/snapshot");
    expect(snapshot.bookings).toHaveLength(1);
    expect(snapshot.bookings[0].startTs).toBe(slot(2) + DAY);
  });

  it("lässt beim Sammelfreigeben ebenfalls aufrücken", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18),
      title: "Session", state: "reserved",
    });
    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    const result = await team.owner.ok("POST", "/api/release", {
      studioId: team.studioId, days: [slot(0)],
    });

    expect(result.granted).toBe(1);
    expect(bookingsOf(await max.ok("GET", "/api/snapshot"), max.userId)).toHaveLength(1);
  });

  it("fasst fremde Buchungen nur an, wer Buchungen verwaltet", async () => {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const lena = await joinApproved(team, "Lena");
    await max.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(2), endTs: slot(6), title: "Mix", state: "occupied",
    });

    const asMember = await lena.ok("POST", "/api/release", {
      studioId: team.studioId, days: [slot(0)],
    });
    expect(asMember.released).toBe(0);
    expect((await lena.ok("GET", "/api/snapshot")).bookings).toHaveLength(1);

    const asOwner = await team.owner.ok("POST", "/api/release", {
      studioId: team.studioId, days: [slot(0)],
    });
    expect(asOwner.released).toBe(1);
    expect((await team.owner.ok("GET", "/api/snapshot")).bookings).toHaveLength(0);
  });

  it("nimmt denselben Tag doppelt entgegen, ohne doppelt zu zählen", async () => {
    const { team, owner } = await threeDays();
    const result = await owner.ok("POST", "/api/release", {
      studioId: team.studioId, days: [slot(0), slot(0), slot(0) + 600],
    });
    expect(result.released).toBe(1);
  });

  it("weist eine leere und eine überlange Auswahl ab", async () => {
    const team = await createTeam();
    expect(await team.owner.failsWith("POST", "/api/release", {
      studioId: team.studioId, days: [],
    })).toBe("badRequest");

    const zuViele = Array.from({ length: 63 }, (_, index) => slot(0) + index * DAY);
    expect(await team.owner.failsWith("POST", "/api/release", {
      studioId: team.studioId, days: zuViele,
    })).toBe("badRequest");
  });

  it("verlangt eine Sitzung", async () => {
    const team = await createTeam();
    const fremd = new Client();
    expect(await fremd.failsWith("POST", "/api/release", {
      studioId: team.studioId, days: [slot(0)],
    })).toBe("notAuthenticated");
  });
});
