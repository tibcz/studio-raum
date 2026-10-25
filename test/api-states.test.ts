import { describe, it, expect } from "vitest";
import { createTeam, joinApproved, slot } from "./helpers";

async function setup() {
  const team = await createTeam();
  const max = await joinApproved(team, "Max");
  return { team, max };
}

describe("Zustand einer Buchung", () => {
  it("trägt eine neue Buchung als sicher belegt ein", async () => {
    const { team } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(14), title: "",
    });
    expect(booking.state).toBe("occupied");
    expect(booking.origin).toBe("manual");
  });

  it("nimmt einen ausdrücklich geblockten Zeitraum an", async () => {
    const { team } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(14), title: "", state: "reserved",
    });
    expect(booking.state).toBe("reserved");
  });

  it("weist einen unbekannten Zustand ab", async () => {
    const { team } = await setup();
    expect(await team.owner.failsWith("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(14), title: "", state: "vielleicht",
    })).toBe("badRequest");
  });

  it("schaltet zwischen geblockt und sicher belegt um", async () => {
    const { team } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(14), title: "", state: "reserved",
    });

    const rot = await team.owner.ok("POST", `/api/bookings/${booking.id}/state`, { state: "occupied" });
    expect(rot.state).toBe("occupied");

    const blau = await team.owner.ok("POST", `/api/bookings/${booking.id}/state`, { state: "reserved" });
    expect(blau.state).toBe("reserved");
  });

  it("lässt einen Fremden den Zustand nicht umschalten", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(14), title: "", state: "reserved",
    });
    expect(await max.failsWith("POST", `/api/bookings/${booking.id}/state`, { state: "occupied" }))
      .toBe("permissionDenied");
  });

  it("behält den Zustand beim Ändern der Zeiten", async () => {
    const { team } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(14), title: "", state: "reserved",
    });
    const geaendert = await team.owner.ok("PATCH", `/api/bookings/${booking.id}`, {
      studioId: team.studioId, startTs: slot(11), endTs: slot(15), title: "",
    });
    expect(geaendert.state).toBe("reserved");
  });
});

describe("Sicher belegt schließt Anfragen aus", () => {
  it("weist eine Anfrage auf einen roten Zeitraum ab", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "",
    });
    expect(await max.failsWith("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    })).toBe("requestNotAllowed");
  });

  it("öffnet den Weg, sobald der Zeitraum auf geblockt steht", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "",
    });
    await team.owner.ok("POST", `/api/bookings/${booking.id}/state`, { state: "reserved" });

    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    expect(request.status).toBe("pending");
  });

  it("beendet offene Anfragen, wenn der Zeitraum auf rot wechselt", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "", state: "reserved",
    });
    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("POST", `/api/bookings/${booking.id}/state`, { state: "occupied" });
    expect((await team.owner.ok("GET", "/api/snapshot")).requests).toHaveLength(0);
  });
});

describe("Behalten statt ablehnen", () => {
  it("lehnt ab und markiert den Zeitraum in einem Zug als sicher belegt", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "", state: "reserved",
    });
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: false, keep: true });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.requests).toHaveLength(0);
    expect(snapshot.bookings.find((b: any) => b.id === booking.id).state).toBe("occupied");

    expect(await max.failsWith("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    })).toBe("requestNotAllowed");
  });

  it("lässt den Zustand unangetastet, wenn nur abgelehnt wird", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "", state: "reserved",
    });
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: false });

    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.bookings.find((b: any) => b.id === booking.id).state).toBe("reserved");
  });
});

describe("Benachrichtigungen", () => {
  it("meldet eine Anfrage bei der Person, der die Buchung gehört", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "", state: "reserved",
    });
    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    const beimBesitzer = await team.owner.ok("GET", "/api/snapshot");
    expect(beimBesitzer.notifications).toHaveLength(1);
    expect(beimBesitzer.notifications[0].kind).toBe("requestCreated");
    expect(beimBesitzer.notifications[0].readAt).toBeNull();

    expect((await max.ok("GET", "/api/snapshot")).notifications).toHaveLength(0);
  });

  it("meldet der anfragenden Person die Freigabe", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "", state: "reserved",
    });
    const request = await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });
    await team.owner.ok("POST", `/api/requests/${request.id}/resolve`, { accept: true });

    const beiMax = await max.ok("GET", "/api/snapshot");
    expect(beiMax.notifications.map((n: any) => n.kind)).toContain("requestAccepted");
  });

  it("markiert Benachrichtigungen als gelesen", async () => {
    const { team, max } = await setup();
    const booking = await team.owner.ok("POST", "/api/bookings", {
      studioId: team.studioId, startTs: slot(10), endTs: slot(18), title: "", state: "reserved",
    });
    await max.ok("POST", "/api/requests", {
      bookingId: booking.id, startTs: slot(12), endTs: slot(14),
    });

    await team.owner.ok("POST", "/api/notifications/read");
    const snapshot = await team.owner.ok("GET", "/api/snapshot");
    expect(snapshot.notifications.every((n: any) => n.readAt !== null)).toBe(true);
  });
});

describe("Einstellungen", () => {
  it("sichert Vibration und Empfang je Person", async () => {
    const { team } = await setup();
    const prefs = await team.owner.ok("PATCH", "/api/preferences", {
      notifyEnabled: true, notifyVibrate: false,
    });
    expect(prefs.notifyVibrate).toBe(false);
    expect((await team.owner.ok("GET", "/api/snapshot")).preferences.notifyVibrate).toBe(false);
  });

  it("nimmt nur Studios des eigenen Teams in die Rangfolge auf", async () => {
    const { team } = await setup();
    const prefs = await team.owner.ok("PATCH", "/api/preferences", {
      studioPriority: [team.studioIds[2], "fremd", team.studioIds[0], team.studioIds[0]],
    });
    expect(prefs.studioPriority).toEqual([team.studioIds[2], team.studioIds[0]]);
  });

  it("weist ein unsinniges Push-Abonnement ab", async () => {
    const { team } = await setup();
    expect(await team.owner.failsWith("POST", "/api/push", {
      endpoint: "http://unsicher.example.com/abo", p256dh: "x", auth: "y",
    })).toBe("badRequest");
    expect(await team.owner.failsWith("POST", "/api/push", {
      endpoint: "https://push.example.com/abo", p256dh: "zu-kurz", auth: "auch",
    })).toBe("badRequest");
  });
});
