import { describe, it, expect } from "vitest";
import {
  SLOT_SECONDS,
  MAXIMUM_DURATION,
  isCanonicalSlot,
  validateRange,
  slotsBetween,
  lockKey,
  snappedRange,
  initialRange,
} from "../src/domain/booking-rules";
import { zonedTimestamp, startOfDay, addDays } from "../src/domain/time";

describe("Slot-Mathematik", () => {
  it("macht aus jeder Picker-Minute einen gültigen Bereich", () => {
    const base = zonedTimestamp(2026, 8, 17, 10, 0, 0, "Europe/Berlin");

    for (let offsetMinutes = 0; offsetMinutes < 60; offsetMinutes++) {
      const start = base + offsetMinutes * 60;
      const range = snappedRange(start, start + 37 * 60);

      expect(isCanonicalSlot(range.start)).toBe(true);
      expect(isCanonicalSlot(range.end)).toBe(true);
      expect(() => validateRange(range.start, range.end)).not.toThrow();
    }
  });

  it("erzeugt beim Runden nie einen leeren oder überlangen Bereich", () => {
    const start = zonedTimestamp(2026, 8, 17, 10, 0, 0, "Europe/Berlin");

    const collapsed = snappedRange(start, start + 60);
    expect(collapsed.end - collapsed.start).toBe(SLOT_SECONDS);

    const inverted = snappedRange(start, start - 3600);
    expect(inverted.end).toBeGreaterThan(inverted.start);

    const overlong = snappedRange(start, start + 72 * 3600);
    expect(overlong.end - overlong.start).toBe(MAXIMUM_DURATION);
    expect(() => validateRange(overlong.start, overlong.end)).not.toThrow();
  });

  it("liefert in jeder relevanten Zeitzone einen kanonischen Startbereich", () => {
    const zones = [
      "Europe/Berlin", "UTC", "America/New_York", "Asia/Kolkata",
      "Asia/Kathmandu", "Pacific/Chatham", "Australia/Adelaide",
    ];
    const now = Math.floor(Date.now() / 1000);

    for (const zone of zones) {
      for (let dayOffset = -2; dayOffset <= 12; dayOffset++) {
        const day = addDays(now, dayOffset, zone);
        const range = initialRange(day, zone, now);

        expect(isCanonicalSlot(range.start), `Start nicht kanonisch in ${zone}`).toBe(true);
        expect(isCanonicalSlot(range.end), `Ende nicht kanonisch in ${zone}`).toBe(true);
        expect(() => validateRange(range.start, range.end)).not.toThrow();
      }
    }
  });

  it("bleibt über beide Zeitumstellungen im gewählten Tag", () => {
    const zone = "Europe/Berlin";
    for (const [month, day] of [[3, 29], [10, 25]] as const) {
      const dayStart = zonedTimestamp(2026, month, day, 0, 0, 0, zone);
      const dayEnd = addDays(dayStart, 1, zone);
      const range = initialRange(dayStart, zone, Math.floor(Date.now() / 1000));

      expect(range.start).toBeGreaterThanOrEqual(dayStart);
      expect(range.end).toBeLessThanOrEqual(dayEnd);
      expect(() => validateRange(range.start, range.end)).not.toThrow();
    }
  });

  it("folgt der absoluten Zeit über die Herbstumstellung", () => {
    const zone = "Europe/Berlin";
    const start = zonedTimestamp(2026, 10, 25, 1, 0, 0, zone);
    const end = zonedTimestamp(2026, 10, 25, 4, 0, 0, zone);

    const slots = slotsBetween(start, end);

    expect(end - start).toBe(4 * 3600);
    expect(slots.length).toBe(16);
    expect(new Set(slots).size).toBe(16);
  });

  it("bindet Lock-Namen an den Zeitpunkt, nicht an die lesende Zeitzone", () => {
    const instant = zonedTimestamp(2026, 8, 17, 10, 0, 0, "Europe/Berlin");
    const sameInstant = zonedTimestamp(2026, 8, 17, 13, 30, 0, "Asia/Kolkata");

    expect(instant).toBe(sameInstant);
    expect(lockKey("studio", instant)).toBe(lockKey("studio", sameInstant));
    expect(lockKey("studio", instant + 900)).not.toBe(lockKey("studio", instant));
  });

  it("hält eine Ganztagsbuchung innerhalb der Schreibgrenze", () => {
    const start = zonedTimestamp(2026, 8, 17, 0, 0, 0, "Europe/Berlin");
    const slots = slotsBetween(start, start + MAXIMUM_DURATION);

    expect(slots.length).toBe(96);
    expect(slots.length + 2).toBeLessThanOrEqual(400);
  });
});
