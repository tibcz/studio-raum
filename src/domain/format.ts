import { zonedParts } from "./time";

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatTime(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatTimeRange(start: number, end: number, timeZone: string): string {
  const endParts = zonedParts(end, timeZone);
  const endLabel = end > start && endParts.hour === 0 && endParts.minute === 0
    ? "24:00"
    : formatTime(end, timeZone);
  return `${formatTime(start, timeZone)} – ${endLabel}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatDayTitle(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  const weekday = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  return `${weekday}, ${p.day} ${MONTHS[p.month - 1]}`;
}

export function formatShortDay(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  const weekday = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]!.slice(0, 3);
  return `${weekday} ${p.day}`;
}

export function formatMonthShort(ts: number, timeZone: string): string {
  return MONTHS[zonedParts(ts, timeZone).month - 1]!.slice(0, 3);
}
