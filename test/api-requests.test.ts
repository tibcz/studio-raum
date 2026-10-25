import { describe, it, expect } from "vitest";
import { createTeam, joinApproved, slot, type Team, type Client } from "./helpers";

async function setup() {
  const team = await createTeam();
  const max = await joinApproved(team, "Max");
  const booking = await team.owner.ok("POST", "/api/bookings", {
    studioId: team.studioId, startTs: slot(10), endTs: slot(18),
    title: "Session", state: "reserved",
  });
  return { team, max, booking };
}

function bookingsOf(snapshot: any, userId: string) {
  return snapshot.bookings
    .filter((b: any) => b.ownerUserId === userId)
    .sort((a: any, b: any) => a.startTs - b.startTs);
}

describe("Zeitraum anfragen", () => {
  it("legt eine Anfrage an und meldet sie beim Besitzer", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    expect(request.status).toBe("pending");
    expect(request.requesterUserId).toBe(max.userId);
    expect(request.bookingOwnerUserId).toBe(team.owner.userId);

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.requests).toHaveLength(1);
  });

  it("leitet dieselbe Kennung aus demselben Zeitraum ab", async () => {
    const { max, booking } = await setup();
    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    expect(await max.failsWith("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    })).toBe("conflict");
  });

  it("weist Zeiträume außerhalb der Buchung ab", async () => {
    const { max, booking } = await setup();
    for (const [from, to] of [[8, 12], [16, 20], [8, 20]]) {
      expect(await max.failsWith("POST", "/api/requests", {
        bookingId: booking.id, startTs: slot(from), endTs: slot(to),
      }), `${from}-${to}`).toBe("invalidTime");
    }
  });

  it("lässt die eigene Buchung nicht anfragen", async () => {
    const { team, booking } = await setup();
    expect(await team.owner.failsWith("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    })).toBe("invalidTime");
  });

  it("lässt die anfragende Person zurückziehen", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await max.ok("DELETE", `/api/requests/${request.id}`);
    expect((await team.owner.ok("GET", "/api/snapshot")).requests).toHaveLength(0);
  });

  it("lässt eine abgelehnte Anfrage erneut stellen", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: false });

    const wieder = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    expect(wieder.status).toBe("pending");
  });

  it("lässt nur den Besitzer der Buchung oder einen Admin entscheiden", async () => {
    const { team, max, booking } = await setup();
    const lena = await joinApproved(team, "Lena");
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    expect(await lena.failsWith("POST", `/api/requests/${request.id}/resolve`, { accept: true }))
      .toBe("permissionDenied");
    expect(await max.failsWith("POST", `/api/requests/${request.id}/resolve`, { accept: true }))
      .toBe("permissionDenied");
  });
});

describe("Teilübergabe", () => {
  it("teilt in der Mitte in drei Abschnitte", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: true });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.bookings).toHaveLength(3);

    const meine = bookingsOf(snapshot, team.owner.userId);
    const seine = bookingsOf(snapshot, max.userId);
    expect(meine.map((b: any) => [b.startTs, b.endTs])).toEqual([
      [slot(10), slot(12)], [slot(14), slot(18)],
    ]);
    expect(seine.map((b: any) => [b.startTs, b.endTs])).toEqual([[slot(12), slot(14)]]);
  });

  it("teilt am Anfang in zwei Abschnitte", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(10), endTs: slot(13),
    });
    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: true });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.bookings).toHaveLength(2);
    expect(bookingsOf(snapshot, max.userId).map((b: any) => [b.startTs, b.endTs]))
      .toEqual([[slot(10), slot(13)]]);
    expect(bookingsOf(snapshot, team.owner.userId).map((b: any) => [b.startTs, b.endTs]))
      .toEqual([[slot(13), slot(18)]]);
  });

  it("teilt am Ende in zwei Abschnitte", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(15), endTs: slot(18),
    });
    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: true });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(bookingsOf(snapshot, team.owner.userId).map((b: any) => [b.startTs, b.endTs]))
      .toEqual([[slot(10), slot(15)]]);
    expect(bookingsOf(snapshot, max.userId).map((b: any) => [b.startTs, b.endTs]))
      .toEqual([[slot(15), slot(18)]]);
  });

  it("überträgt die ganze Buchung, wenn der Zeitraum genau passt", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(10), endTs: slot(18),
    });
    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: true });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.bookings).toHaveLength(1);
    expect(snapshot.bookings[0].id).toBe(booking.id);
    expect(snapshot.bookings[0].ownerUserId).toBe(max.userId);
  });

  it("lässt nach der Teilung keinen Slot doppelt oder frei", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: true });

    const lena = await joinApproved(team, "Lena");
    for (const [from, to] of [[10, 12], [12, 14], [14, 18], [10, 18]]) {
      expect(await lena.failsWith("POST", "/api/bookings", {
        studioId: team.studioId, startTs: slot(from), endTs: slot(to), title: "",
      }), `${from}-${to}`).toBe("bookingConflict");
    }
    await lena.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(8), endTs: slot(10), title: "",
    });
    await lena.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(18), endTs: slot(20), title: "",
    });
  });

  it("übergibt nicht an eine inzwischen gesperrte Person", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("PATCH", `/api/members/${max.userId}`, {
      displayName: "Max", role: "member", isActive: false, canWrite: true,
    });

    expect(await team.owner.failsWith("POST", `/api/requests/${request.id}/resolve`, { accept: true }))
      .toBe("requestNoLongerAvailable");
  });

  it("entwertet offene Anfragen, wenn die Buchung gelöscht wird", async () => {
    const { team, max, booking } = await setup();
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    await team.owner.ok("DELETE", `/api/bookings/${booking.id}`);

    expect((await team.owner.ok("GET", "/api/snapshot")).requests).toHaveLength(0);
    expect(await team.owner.failsWith("POST", `/api/requests/${request.id}/resolve`, { accept: true }))
      .toBe("requestNoLongerAvailable");
  });
});

describe("Anfrage durch einen Admin", () => {
  async function adminSetup() {
    const team = await createTeam();
    const max = await joinApproved(team, "Max");
    const booking = await max.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18),
      title: "Session", state: "reserved",
    });
    return { team, max, booking };
  }

  it("lässt einen Admin einen Teil einer fremden Buchung anfragen", async () => {
    const { team, max, booking } = await adminSetup();

    const request = await team.owner.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    expect(request.status).toBe("pending");
    expect(request.requesterUserId).toBe(team.owner.userId);
    expect(request.bookingOwnerUserId).toBe(max.userId);
    expect((await max.ok("GET", "/api/snapshot")).requests).toHaveLength(1);
  });

  it("lässt einen Admin die eigene Anfrage nicht selbst genehmigen", async () => {
    const { team, booking } = await adminSetup();
    const request = await team.owner.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    expect(await team.owner.failsWith("POST", `/api/requests/${request.id}/resolve`, { accept: true }))
      .toBe("permissionDenied");
    expect(await team.owner.failsWith("POST", `/api/requests/${request.id}/resolve`, { accept: false }))
      .toBe("permissionDenied");
  });

  it("lässt die buchende Person die Anfrage des Admins beantworten", async () => {
    const { team, max, booking } = await adminSetup();
    const request = await team.owner.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await max.ok("POST", `/api/requests/${request.id}/resolve`, { accept: true });

    const snapshot = await max.ok("GET", "/api/snapshot");
    expect(bookingsOf(snapshot, team.owner.userId).map((b: any) => [b.startTs, b.endTs]))
      .toEqual([[slot(12), slot(14)]]);
    expect(bookingsOf(snapshot, max.userId).map((b: any) => [b.startTs, b.endTs]))
      .toEqual([[slot(10), slot(12)], [slot(14), slot(18)]]);
  });

  it("lässt den Admin die eigene Anfrage weiterhin zurückziehen", async () => {
    const { team, max, booking } = await adminSetup();
    const request = await team.owner.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("DELETE", `/api/requests/${request.id}`);
    expect((await max.ok("GET", "/api/snapshot")).requests).toHaveLength(0);
  });
});
