import { fail } from "./errors";
import { startOfDay, addDays, isSameDay } from "./time";

export const SLOT_MINUTES = 15;
export const SLOT_SECONDS = SLOT_MINUTES * 60;
export const MAXIMUM_DURATION = 24 * 60 * 60;

export function isCanonicalSlot(ts: number): boolean {
  return Number.isFinite(ts) && Number.isInteger(ts) && ts % SLOT_SECONDS === 0;
}

export function validateRange(start: number, end: number): void {
  if (
    !(start < end) ||
    end - start > MAXIMUM_DURATION ||
    !isCanonicalSlot(start) ||
    !isCanonicalSlot(end)
  ) {
    fail("invalidTime");
  }
}

export function slotsBetween(start: number, end: number): number[] {
  validateRange(start, end);
  const slots: number[] = [];
  for (let cursor = start; cursor < end; cursor += SLOT_SECONDS) slots.push(cursor);
  return slots;
}

export function lockKey(studioId: string, ts: number): string {
  return `${studioId} ${roundedDownToSlot(ts)}`;
}

export function roundedUpToSlot(ts: number): number {
  return Math.ceil(ts / SLOT_SECONDS) * SLOT_SECONDS;
}

export function roundedDownToSlot(ts: number): number {
  return Math.floor(ts / SLOT_SECONDS) * SLOT_SECONDS;
}

export function snappedToSlot(ts: number): number {
  return Math.round(ts / SLOT_SECONDS) * SLOT_SECONDS;
}

export function snappedRange(start: number, end: number): { start: number; end: number } {
  const snappedStart = snappedToSlot(start);
  let snappedEnd = snappedToSlot(end);
  if (snappedEnd <= snappedStart) snappedEnd = snappedStart + SLOT_SECONDS;
  if (snappedEnd - snappedStart > MAXIMUM_DURATION) snappedEnd = snappedStart + MAXIMUM_DURATION;
  return { start: snappedStart, end: snappedEnd };
}

export function overlapsDay(
  booking: { startTs: number; endTs: number },
  day: number,
  timeZone: string,
): boolean {
  const start = startOfDay(day, timeZone);
  const end = addDays(start, 1, timeZone);
  return booking.startTs < end && booking.endTs > start;
}

export function initialRange(
  day: number,
  timeZone: string,
  now: number = Math.floor(Date.now() / 1000),
): { start: number; end: number } {
  const dayStart = startOfDay(day, timeZone);
  const dayEnd = addDays(dayStart, 1, timeZone);
  const lastStart = roundedDownToSlot(dayEnd - SLOT_SECONDS);

  const isToday = isSameDay(day, now, timeZone);
  const preferred = dayStart + (isToday ? 8 : 10) * 3600;
  let start = isToday ? Math.max(roundedUpToSlot(now), preferred) : preferred;
  start = Math.min(snappedToSlot(start), lastStart);

  const end = Math.min(snappedToSlot(start + 2 * 3600), roundedDownToSlot(dayEnd));
  return snappedRange(start, end);
}

export const INPUT_STEP_MINUTES = 30;
export const INPUT_STEP_SECONDS = INPUT_STEP_MINUTES * 60;

export function snappedToStep(ts: number, stepSeconds: number = INPUT_STEP_SECONDS): number {
  return Math.round(ts / stepSeconds) * stepSeconds;
}

export function snappedRangeToStep(
  start: number, end: number, stepSeconds: number = INPUT_STEP_SECONDS,
): { start: number; end: number } {
  const snappedStart = snappedToStep(start, stepSeconds);
  let snappedEnd = snappedToStep(end, stepSeconds);
  if (snappedEnd <= snappedStart) snappedEnd = snappedStart + stepSeconds;
  if (snappedEnd - snappedStart > MAXIMUM_DURATION) snappedEnd = snappedStart + MAXIMUM_DURATION;
  return { start: snappedStart, end: snappedEnd };
}

export interface Interval {
  start: number;
  end: number;
}

export interface StatedInterval extends Interval {
  state: "reserved" | "occupied";
}

export function dayBounds(day: number, timeZone: string): Interval {
  const start = startOfDay(day, timeZone);
  return { start, end: addDays(start, 1, timeZone) };
}

export function clipped(range: Interval, window: Interval): Interval | null {
  const start = Math.max(range.start, window.start);
  const end = Math.min(range.end, window.end);
  return start < end ? { start, end } : null;
}

export function mergedIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) {
      if (item.end > last.end) last.end = item.end;
    } else {
      merged.push({ start: item.start, end: item.end });
    }
  }
  return merged;
}

export function gapsIn(intervals: Interval[], window: Interval): Interval[] {
  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const item of mergedIntervals(
    intervals.map((i) => clipped(i, window)).filter((i): i is Interval => i !== null),
  )) {
    if (item.start > cursor) gaps.push({ start: cursor, end: item.start });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

export function freeIntervals(
  bookings: ReadonlyArray<Interval>, day: number, timeZone: string,
): Interval[] {
  return gapsIn([...bookings], dayBounds(day, timeZone));
}

export function dayState(
  bookings: ReadonlyArray<StatedInterval>, day: number, timeZone: string,
): "free" | "partial" | "reserved" | "occupied" {
  return dayStateIn(bookings, dayBounds(day, timeZone));
}

export function dayStateIn(
  bookings: ReadonlyArray<StatedInterval>, window: Interval,
): "free" | "partial" | "reserved" | "occupied" {
  const inDay = bookings.filter((b) => clipped(b, window) !== null);

  if (inDay.length === 0) return "free";
  if (gapsIn(inDay, window).length > 0) return "partial";
  return inDay.some((b) => b.state === "occupied") ? "occupied" : "reserved";
}

export function isRequestable(booking: { state: "reserved" | "occupied" }): boolean {
  return booking.state === "reserved";
}
