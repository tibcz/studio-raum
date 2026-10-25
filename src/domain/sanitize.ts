import { fail } from "./errors";

const STRIPPED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu;

export function sanitizedText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(STRIPPED, "").trim().slice(0, maximumLength);
}

export function requiredText(value: unknown, maximumLength: number, minimum = 1): string {
  const clean = sanitizedText(value, maximumLength);
  if (clean.length < minimum) fail("invalidText");
  return clean;
}

export const TEXT_LIMITS = {
  displayName: 100,
  teamName: 100,
  studioName: 100,
  subtitle: 200,
  title: 500,
  message: 500,
} as const;
