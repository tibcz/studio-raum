import { describe, it, expect } from "vitest";
import { createTeam, joinApproved, slot, type Client, type Team } from "./helpers";

interface Bühne {
  team: Team;
  fly: Client;
  max: Client;
  a: string;
  b: string;
  c: string;
}

async function bühne(zustand: "reserved" | "occupied" = "reserved"): Promise<Bühne> {
  const team = await createTeam();
  const fly = await joinApproved(team, "Fly");
  const max = await joinApproved(team, "Max");
  const [a, b, c] = team.studioIds as [string, string, string];

  await team.owner.ok("POST", "/api/bookings", {
    studioId: a, startTs: slot(10), endTs: slot(18), title: "Ali", state: zustand,
  });
  await fly.ok("POST", "/api/bookings", {
    studioId: b, startTs: slot(10), endTs: slot(18), title: "Fly", state: zustand,
  });
  await max.ok("PATCH", "/api/preferences", { studioPriority: [a, b, c] });

  return { team, fly, max, a, b, c };
}

function offeneAnfragen(snapshot: any, dayRequestId: string) {
  return snapshot.requests.filter((r: any) => r.dayRequestId === dayRequestId);
}

describe("Tagesanfrage über alle Studios", () => {
  it("merkt den freien Raum vor und fragt die besseren an", async () => {
    const { team, max, a, b, c } = await bühne();

    const anfrage = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: null, note: "Vocals",
    });

    expect(anfrage.status).toBe("pending");
    expect(anfrage.scope).toBe("cascade");
    expect(anfrage.provisionalBookingId).not.toBeNull();

    const snapshot = await max.ok("GET", "/api/snapshot");
    const vormerkung = snapshot.bookings.find((x: any) => x.id === anfrage.provisionalBookingId);
    expect(vormerkung.studioId).toBe(c);
    expect(vormerkung.ownerUserId).toBe(max.userId);
    expect(vormerkung.state).toBe("reserved");
    expect(vormerkung.origin).toBe("provisional");

    const anfragen = offeneAnfragen(snapshot, anfrage.id);
    expect(anfragen.map((r: any) => r.studioId).sort()).toEqual([a, b].sort());
    for (const request of anfragen) {
      expect([request.startTs, request.endTs]).toEqual([slot(12), slot(14)]);
    }
  });

  it("richtet sich nach der persönlichen Rangfolge", async () => {
    const team = await createTeam();
    const fly = await joinApproved(team, "Fly");
    const max = await joinApproved(team, "Max");
    const [a, b, c] = team.studioIds as [string, string, string];

    await team.owner.ok("POST", "/api/bookings", {
      studioId: a, startTs: slot(10), endTs: slot(18), title: "", state: "reserved",
    });
    await fly.ok("POST", "/api/bookings", {
      studioId: c, startTs: slot(10), endTs: slot(18), title: "", state: "reserved",
    });

    await max.ok("PATCH", "/api/preferences", { studioPriority: [a, b, c] });
    const knapp = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(13), studioId: null, note: "",
    });
    const eine = offeneAnfragen(await max.ok("GET", "/api/snapshot"), knapp.id);
    expect(eine.map((r: any) => r.studioId)).toEqual([a]);
    await max.ok("DELETE", `/api/day-requests/${knapp.id}`);

    await max.ok("PATCH", "/api/preferences", { studioPriority: [c, a, b] });
    const weit = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(13), studioId: null, note: "",
    });
    const zwei = offeneAnfragen(await max.ok("GET", "/api/snapshot"), weit.id);
    expect(zwei.map((r: any) => r.studioId).sort()).toEqual([a, c].sort());

    const snapshot = await max.ok("GET", "/api/snapshot");
    expect(snapshot.bookings.find((x: any) => x.id === weit.provisionalBookingId).studioId).toBe(b);
  });

  it("trägt die anfragende Person nach einer Freigabe direkt ein", async () => {
    const { team, max, a, c } = await bühne();
    const anfrage = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: null, note: "",
    });

    const anfragen = offeneAnfragen(await max.ok("GET", "/api/snapshot"), anfrage.id);
    const fürA = anfragen.find((r: any) => r.studioId === a);
    await team.owner.ok("POST", `/api/requests/${fürA.id}/resolve`, { accept: true });

    const snapshot = await max.ok("GET", "/api/snapshot");
    const erledigt = snapshot.dayRequests.find((r: any) => r.id === anfrage.id);
    expect(erledigt.status).toBe("fulfilled");
    expect(erledigt.grantedStudioId).toBe(a);

    const inA = snapshot.bookings.filter(
      (x: any) => x.studioId === a && x.ownerUserId === max.userId);
    expect(inA.map((x: any) => [x.startTs, x.endTs])).toEqual([[slot(12), slot(14)]]);

    expect(snapshot.bookings.some((x: any) => x.id === anfrage.provisionalBookingId)).toBe(false);
    expect(snapshot.bookings.some((x: any) => x.studioId === c)).toBe(false);

    expect(offeneAnfragen(snapshot, anfrage.id)).toHaveLength(0);
  });

  it("macht die Vormerkung fest, wenn niemand freigibt", async () => {
    const { team, fly, max, c } = await bühne();
    const anfrage = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: null, note: "",
    });

    const anfragen = offeneAnfragen(await max.ok("GET", "/api/snapshot"), anfrage.id);
    for (const request of anfragen) {
      const antwortender = request.bookingOwnerUserId === fly.userId ? fly : team.owner;
      await antwortender.ok("POST", `/api/requests/${request.id}/resolve`, { accept: false });
    }

    const snapshot = await max.ok("GET", "/api/snapshot");
    const erledigt = snapshot.dayRequests.find((r: any) => r.id === anfrage.id);
    expect(erledigt.status).toBe("fulfilled");
    expect(erledigt.grantedStudioId).toBe(c);

    const vormerkung = snapshot.bookings.find((x: any) => x.studioId === c);
    expect(vormerkung.ownerUserId).toBe(max.userId);
    expect(vormerkung.state).toBe("occupied");
    expect(vormerkung.origin).toBe("manual");
  });

  it("bucht sofort, wenn schon der erste Wunsch frei ist", async () => {
    const { max, a, b, c } = await bühne();
    await max.ok("PATCH", "/api/preferences", { studioPriority: [c, a, b] });

    const anfrage = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: null, note: "Direkt",
    });

    expect(anfrage.status).toBe("fulfilled");
    expect(anfrage.grantedStudioId).toBe(c);
    expect(anfrage.provisionalBookingId).toBeNull();

    const snapshot = await max.ok("GET", "/api/snapshot");
    expect(offeneAnfragen(snapshot, anfrage.id)).toHaveLength(0);
    expect(snapshot.bookings.find((x: any) => x.studioId === c).state).toBe("occupied");
  });

  it("meldet, wenn kein Raum frei und keiner anfragbar ist", async () => {
    const { max, c } = await bühne("occupied");
    await max.ok("POST", "/api/bookings", {
      studioId: c, startTs: slot(10), endTs: slot(18), title: "", state: "occupied",
    });

    expect(await max.failsWith("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: null, note: "",
    })).toBe("noStudioAvailable");
  });

  it("nimmt die Vormerkung mit zurück", async () => {
    const { max, c } = await bühne();
    const anfrage = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: null, note: "",
    });

    await max.ok("DELETE", `/api/day-requests/${anfrage.id}`);

    const snapshot = await max.ok("GET", "/api/snapshot");
    expect(offeneAnfragen(snapshot, anfrage.id)).toHaveLength(0);
    expect(snapshot.bookings.some((x: any) => x.studioId === c)).toBe(false);
    expect(snapshot.dayRequests.find((r: any) => r.id === anfrage.id).status).toBe("cancelled");
  });
});

describe("Tagesanfrage für ein einzelnes Studio", () => {
  it("fragt nur diesen Raum an und merkt nichts vor", async () => {
    const { max, a } = await bühne();

    const anfrage = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: a, note: "Nur Alis Raum",
    });

    expect(anfrage.scope).toBe("single");
    expect(anfrage.provisionalBookingId).toBeNull();

    const anfragen = offeneAnfragen(await max.ok("GET", "/api/snapshot"), anfrage.id);
    expect(anfragen).toHaveLength(1);
    expect(anfragen[0].studioId).toBe(a);
  });

  it("bucht einen freien Raum ohne Umweg", async () => {
    const { max, c } = await bühne();
    const anfrage = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: c, note: "",
    });
    expect(anfrage.status).toBe("fulfilled");
    expect(anfrage.grantedStudioId).toBe(c);
  });

  it("weist einen sicher belegten Raum ab", async () => {
    const { max, a } = await bühne("occupied");
    expect(await max.failsWith("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: a, note: "",
    })).toBe("requestNotAllowed");
  });
});

describe("Benachrichtigung über den Wasserfall", () => {
  it("erreicht jeden Stammnutzer, dessen Raum angefragt wird", async () => {
    const { team, fly, max } = await bühne();
    await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: null, note: "",
    });

    for (const person of [team.owner, fly]) {
      const meldungen = (await person.ok("GET", "/api/snapshot")).notifications;
      expect(meldungen).toHaveLength(1);
      expect(meldungen[0].kind).toBe("requestCreated");
    }
  });

  it("meldet der anfragenden Person das Ergebnis", async () => {
    const { team, max, a } = await bühne();
    const anfrage = await max.ok("POST", "/api/day-requests", {
      startTs: slot(12), endTs: slot(14), studioId: null, note: "",
    });
    const fürA = offeneAnfragen(await max.ok("GET", "/api/snapshot"), anfrage.id)
      .find((r: any) => r.studioId === a);
    await team.owner.ok("POST", `/api/requests/${fürA.id}/resolve`, { accept: true });

    const meldungen = (await max.ok("GET", "/api/snapshot")).notifications;
    expect(meldungen.map((n: any) => n.kind)).toContain("dayRequestFulfilled");
  });
});
