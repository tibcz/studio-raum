import { describe, it, expect } from "vitest";
import {
  dayBounds, dayState, dayStateIn, freeIntervals, gapsIn, isRequestable, mergedIntervals,
  snappedRangeToStep, snappedToStep, type StatedInterval,
} from "../src/domain/booking-rules";
import { weekdayOf, isWeekend } from "../src/domain/time";
import { isWeekendDay } from "../src/domain/models";

const ZONE = "Europe/Berlin";

const MONTAG = Date.UTC(2026, 0, 4, 23, 0, 0) / 1000;

function at(hour: number, minute = 0): number {
  return MONTAG + hour * 3600 + minute * 60;
}

function span(fromHour: number, toHour: number, state: "reserved" | "occupied" = "reserved"): StatedInterval {
  return { start: at(fromHour), end: at(toHour), state };
}

describe("Zustand eines Tages", () => {
  it("nennt einen Tag ohne Buchung frei", () => {
    expect(dayState([], MONTAG, ZONE)).toBe("free");
  });

  it("nennt einen angebrochenen Tag teilweise belegt", () => {
    expect(dayState([span(10, 14)], MONTAG, ZONE)).toBe("partial");
    expect(dayState([span(10, 14, "occupied")], MONTAG, ZONE)).toBe("partial");
  });

  it("nennt einen lückenlos geblockten Tag geblockt", () => {
    expect(dayState([span(0, 24)], MONTAG, ZONE)).toBe("reserved");
    expect(dayState([span(0, 12), span(12, 24)], MONTAG, ZONE)).toBe("reserved");
  });

  it("lässt eine einzige sichere Belegung den ganzen Tag rot färben", () => {
    expect(dayState([span(0, 12, "occupied"), span(12, 24)], MONTAG, ZONE)).toBe("occupied");
  });

  it("übergeht Buchungen, die den Tag gar nicht berühren", () => {
    const gestern: StatedInterval = { start: at(-10), end: at(-2), state: "occupied" };
    expect(dayState([gestern], MONTAG, ZONE)).toBe("free");
  });

  it("kommt mit vorberechneten Grenzen zum selben Ergebnis", () => {
    const faelle: StatedInterval[][] = [
      [],
      [span(10, 14)],
      [span(0, 24)],
      [span(0, 12, "occupied"), span(12, 24)],
    ];
    for (const fall of faelle) {
      expect(dayStateIn(fall, dayBounds(MONTAG, ZONE))).toBe(dayState(fall, MONTAG, ZONE));
    }
  });

  it("zählt eine Buchung über Mitternacht für beide Tage", () => {
    const nacht: StatedInterval = { start: at(22), end: at(26), state: "reserved" };
    expect(dayState([nacht], MONTAG, ZONE)).toBe("partial");
    expect(dayState([nacht], MONTAG + 86400, ZONE)).toBe("partial");
  });
});

describe("Freie Zeiten", () => {
  it("meldet die Lücken vor und nach einer Buchung", () => {
    const bounds = dayBounds(MONTAG, ZONE);
    expect(freeIntervals([{ start: at(10), end: at(14) }], MONTAG, ZONE)).toEqual([
      { start: bounds.start, end: at(10) },
      { start: at(14), end: bounds.end },
    ]);
  });

  it("meldet nichts, wenn der Tag lückenlos belegt ist", () => {
    expect(freeIntervals([{ start: at(0), end: at(24) }], MONTAG, ZONE)).toEqual([]);
  });

  it("führt aneinandergrenzende Buchungen zusammen", () => {
    expect(mergedIntervals([
      { start: at(10), end: at(12) },
      { start: at(12), end: at(14) },
      { start: at(9), end: at(10) },
    ])).toEqual([{ start: at(9), end: at(14) }]);
  });

  it("schneidet Buchungen auf das Fenster zu", () => {
    expect(gapsIn(
      [{ start: at(-5), end: at(2) }],
      { start: at(0), end: at(6) },
    )).toEqual([{ start: at(2), end: at(6) }]);
  });
});

describe("Halbstundenraster", () => {
  it("rundet auf die nächste halbe Stunde", () => {
    expect(snappedToStep(at(10, 14))).toBe(at(10));
    expect(snappedToStep(at(10, 16))).toBe(at(10, 30));
    expect(snappedToStep(at(10, 45))).toBe(at(11));
  });

  it("hält mindestens eine halbe Stunde ein", () => {
    expect(snappedRangeToStep(at(10), at(10, 5))).toEqual({ start: at(10), end: at(10, 30) });
  });

  it("kappt bei vierundzwanzig Stunden", () => {
    const range = snappedRangeToStep(at(0), at(40));
    expect(range.end - range.start).toBe(24 * 3600);
  });
});

describe("Anfragbarkeit", () => {
  it("erlaubt eine Anfrage nur auf einen geblockten Zeitraum", () => {
    expect(isRequestable({ state: "reserved" })).toBe(true);
    expect(isRequestable({ state: "occupied" })).toBe(false);
  });
});

describe("Wochentage", () => {
  it("bestimmt den Wochentag in der Zone des Teams", () => {
    expect(weekdayOf(MONTAG, ZONE)).toBe(1);
    expect(weekdayOf(MONTAG + 5 * 86400, ZONE)).toBe(6);
    expect(weekdayOf(MONTAG + 6 * 86400, ZONE)).toBe(0);
  });

  it("erkennt Samstag und Sonntag als Wochenende", () => {
    expect(isWeekend(MONTAG, ZONE)).toBe(false);
    expect(isWeekend(MONTAG + 5 * 86400, ZONE)).toBe(true);
    expect(isWeekend(MONTAG + 6 * 86400, ZONE)).toBe(true);
    expect([0, 6].every(isWeekendDay)).toBe(true);
    expect([1, 2, 3, 4, 5].some(isWeekendDay)).toBe(false);
  });

  it("richtet sich nach der Zone, nicht nach UTC", () => {
    const sonntagAbendUtc = Date.UTC(2026, 0, 4, 23, 30, 0) / 1000;
    expect(weekdayOf(sonntagAbendUtc, "UTC")).toBe(0);
    expect(weekdayOf(sonntagAbendUtc, ZONE)).toBe(1);
  });
});
