import { zonedParts, zonedTimestamp } from "../domain/time";

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function toDateInput(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function toTimeInput(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function fromInputs(date: string, time: string, timeZone: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return null;

  return zonedTimestamp(
    Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]),
    Number(timeMatch[1]), Number(timeMatch[2]), 0,
    timeZone,
  );
}

export function durationText(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function timeZoneOptions(current: string): string[] {
  const common = [
    "Europe/Berlin", "Europe/Vienna", "Europe/Zurich", "Europe/London",
    "Europe/Madrid", "Europe/Rome", "Europe/Warsaw", "Europe/Athens",
    "UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo",
    "Australia/Sydney",
  ];
  const guessed = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Array.from(new Set([current, guessed, ...common].filter(Boolean)));
}
