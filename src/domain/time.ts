
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(ts: number, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(ts * 1000));
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

export function offsetSeconds(ts: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUTC - ts;
}

export function zonedTimestamp(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  let ts = wall - offsetSeconds(wall, timeZone);
  ts = wall - offsetSeconds(ts, timeZone);
  return ts;
}

export function startOfDay(ts: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  return zonedTimestamp(p.year, p.month, p.day, 0, 0, 0, timeZone);
}

export function addDays(ts: number, days: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedTimestamp(
    shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(),
    0, 0, 0, timeZone,
  );
}

export function isSameDay(a: number, b: number, timeZone: string): boolean {
  return startOfDay(a, timeZone) === startOfDay(b, timeZone);
}

export function isValidTimeZone(identifier: string): boolean {
  if (typeof identifier !== "string" || identifier.length === 0 || identifier.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: identifier });
    return true;
  } catch {
    return false;
  }
}

export function weekdayOf(ts: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

export function isWeekend(ts: number, timeZone: string): boolean {
  const day = weekdayOf(ts, timeZone);
  return day === 0 || day === 6;
}
