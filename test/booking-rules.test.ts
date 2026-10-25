import { describe, it, expect } from "vitest";
import {
  isCanonicalSlot,
  validateRange,
  slotsBetween,
  lockKey,
  overlapsDay,
} from "../src/domain/booking-rules";
import { zonedTimestamp, addDays } from "../src/domain/time";
import { allows } from "../src/domain/authorization";
import type { TeamMember } from "../src/domain/models";
import { StudioRaumError } from "../src/domain/errors";

const BERLIN = "Europe/Berlin";

describe("Buchungsregeln", () => {
  it("teilt zwei Stunden in acht Viertelstunden", () => {
    const start = zonedTimestamp(2026, 8, 17, 10, 0, 0, BERLIN);
    const slots = slotsBetween(start, start + 2 * 3600);

    expect(slots.length).toBe(8);
    expect(slots[0]).toBe(start);
    expect(slots[7]).toBe(start + 105 * 60);
  });

  it("erzeugt stabile, studiospezifische Lock-Namen", () => {
    const date = zonedTimestamp(2026, 8, 17, 10, 15, 0, BERLIN);

    expect(lockKey("studio-a", date)).toBe(lockKey("studio-a", date));
    expect(lockKey("studio-a", date)).not.toBe(lockKey("studio-b", date));
  });

  it("weist Zeiten außerhalb des Rasters und leere Bereiche ab", () => {
    const invalidStart = zonedTimestamp(2026, 8, 17, 10, 7, 0, BERLIN);
    const validEnd = zonedTimestamp(2026, 8, 17, 11, 0, 0, BERLIN);

    expect(() => validateRange(invalidStart, validEnd)).toThrow(StudioRaumError);
    expect(() => validateRange(invalidStart, validEnd)).toThrow(/15-minute steps/);
    expect(() => validateRange(validEnd, validEnd)).toThrow(StudioRaumError);
  });

  it("weist Viertelstunden mit versteckten Sekunden ab", () => {
    const start = zonedTimestamp(2026, 8, 17, 10, 0, 1, BERLIN);
    expect(() => validateRange(start, start + 3600)).toThrow(StudioRaumError);
  });

  it("weist nicht ganzzahlige und nicht endliche Zeiten ab", () => {
    const start = zonedTimestamp(2026, 8, 17, 10, 0, 0, BERLIN);
    expect(isCanonicalSlot(start + 0.5)).toBe(false);
    expect(isCanonicalSlot(Number.NaN)).toBe(false);
    expect(isCanonicalSlot(Number.POSITIVE_INFINITY)).toBe(false);
    expect(() => validateRange(start, start + 25 * 3600)).toThrow(StudioRaumError);
  });

  it("überlappt Tage halboffen", () => {
    const day = zonedTimestamp(2026, 8, 17, 0, 0, 0, BERLIN);
    const nextDay = addDays(day, 1, BERLIN);
    const booking = { startTs: nextDay, endTs: nextDay + 3600 };

    expect(overlapsDay(booking, day, BERLIN)).toBe(false);
    expect(overlapsDay(booking, nextDay, BERLIN)).toBe(true);
  });

  it("bildet versteckte Sekunden zur Sicherheit auf den kanonischen Lock ab", () => {
    const canonical = zonedTimestamp(2026, 8, 17, 10, 0, 0, BERLIN);
    expect(lockKey("studio", canonical + 37)).toBe(lockKey("studio", canonical));
  });
});

describe("Autorisierung", () => {
  const member = (over: Partial<TeamMember> = {}): TeamMember => ({
    userId: "u", displayName: "P", role: "member" as const,
    isActive: true, isPending: false, isPlaceholder: false, createdAt: 0, ...over,
  });

  it("gibt gesperrten Mitgliedern nie Anwendungsrechte", () => {
    const inactiveAdmin = member({ role: "admin", isActive: false });
    const activeMember = member();

    expect(allows(inactiveAdmin, "participate")).toBe(false);
    expect(allows(inactiveAdmin, "manageTeam")).toBe(false);
    expect(allows(activeMember, "participate")).toBe(true);
    expect(allows(activeMember, "manageBookings")).toBe(false);
  });

  it("gibt wartenden Mitgliedern überhaupt kein Recht", () => {
    const pending = member({ isActive: false, isPending: true });

    expect(allows(pending, "participate")).toBe(false);
    expect(allows(pending, "manageBookings")).toBe(false);
    expect(allows(pending, "manageTeam")).toBe(false);
  });

  it("gibt Admin und Besitzer die Verwaltungsrechte", () => {
    for (const role of ["admin", "owner"] as const) {
      const person = member({ role });
      expect(allows(person, "participate")).toBe(true);
      expect(allows(person, "manageBookings")).toBe(true);
      expect(allows(person, "manageTeam")).toBe(true);
    }
  });
});
