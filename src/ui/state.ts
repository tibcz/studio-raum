import type {
  AppNotification, Booking, BookingRequest, DayRequest, DayState, MemberPreferences,
  StandingRule, Studio, TeamMember, TeamSnapshot,
} from "../domain/models";
import { DEFAULT_PREFERENCES, STANDING_HORIZON_DAYS } from "../domain/models";
import { canManageBookings, canManageTeam } from "../domain/authorization";
import {
  dayState, dayStateIn, freeIntervals, overlapsDay, type Interval,
} from "../domain/booking-rules";
import { addDays, startOfDay } from "../domain/time";

export type Screen = "loading" | "signin" | "secret" | "waiting" | "app";
export type Tab = "plan" | "calendar" | "bookings" | "settings";

export interface RevealedSecret {
  personalSecret: string;
  joinSecret?: string;
  status?: "active" | "pending" | "readOnly";
}

interface State {
  screen: Screen;
  tab: Tab;
  snapshot: TeamSnapshot | null;
  selectedDay: number;
  calendarMonth: number;
  calendarStudioId: string | null;
  calendarSelection: number[];
  calendarSelecting: boolean;
  busy: boolean;
  reveal: RevealedSecret | null;
}

const listeners = new Set<() => void>();

export const state: State = {
  screen: "loading",
  tab: "plan",
  snapshot: null,
  selectedDay: Math.floor(Date.now() / 1000),
  calendarMonth: Math.floor(Date.now() / 1000),
  calendarStudioId: null,
  calendarSelection: [],
  calendarSelecting: false,
  busy: false,
  reveal: null,
};

export function subscribe(listener: () => void): void {
  listeners.add(listener);
}

export function update(patch: Partial<State>): void {
  Object.assign(state, patch);
  for (const listener of listeners) listener();
}

export function snapshot(): TeamSnapshot {
  if (!state.snapshot) throw new Error("No snapshot loaded.");
  return state.snapshot;
}

export function timeZone(): string {
  return state.snapshot?.team.timeZone ?? "Europe/Berlin";
}

export function currentUserId(): string {
  return state.snapshot?.currentUserId ?? "";
}

export function canWrite(): boolean {
  return state.snapshot?.canWrite === true;
}

export function isManager(): boolean {
  const snap = state.snapshot;
  return snap !== null && snap.canWrite && canManageTeam(snap.role);
}

export function isBookingManager(): boolean {
  const snap = state.snapshot;
  return snap !== null && snap.canWrite && canManageBookings(snap.role);
}

export function activeStudios(): Studio[] {
  return (state.snapshot?.studios ?? [])
    .filter((s) => s.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "en"));
}

export function allStudios(): Studio[] {
  return [...(state.snapshot?.studios ?? [])]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "en"));
}

export function studio(id: string): Studio | undefined {
  return state.snapshot?.studios.find((s) => s.id === id);
}

export function studioName(id: string): string {
  return studio(id)?.name ?? "Studio";
}

export function member(id: string): TeamMember | undefined {
  return state.snapshot?.members.find((m) => m.userId === id);
}

export function memberName(id: string): string {
  return member(id)?.displayName ?? "Member";
}

export function booking(id: string): Booking | undefined {
  return state.snapshot?.bookings.find((b) => b.id === id);
}

export function bookingsFor(studioId: string, day: number): Booking[] {
  return (state.snapshot?.bookings ?? [])
    .filter((b) => b.studioId === studioId && overlapsDay(b, day, timeZone()))
    .sort((a, b) => a.startTs - b.startTs);
}

export function myUpcomingBookings(): Booking[] {
  const now = Math.floor(Date.now() / 1000);
  return (state.snapshot?.bookings ?? [])
    .filter((b) => b.ownerUserId === currentUserId() && b.endTs > now)
    .sort((a, b) => a.startTs - b.startTs);
}

export function incomingRequests(): BookingRequest[] {
  return (state.snapshot?.requests ?? [])
    .filter((r) => r.bookingOwnerUserId === currentUserId() && r.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function outgoingRequests(): BookingRequest[] {
  return (state.snapshot?.requests ?? [])
    .filter((r) => r.requesterUserId === currentUserId() && r.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function pendingMembers(): TeamMember[] {
  return (state.snapshot?.members ?? [])
    .filter((m) => m.isPending)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function today(): number {
  return startOfDay(Math.floor(Date.now() / 1000), timeZone());
}

export function dayStateFor(studioId: string, day: number): DayState {
  const spans = bookingsFor(studioId, day)
    .map((b) => ({ start: b.startTs, end: b.endTs, state: b.state }));
  return dayState(spans, day, timeZone());
}

export function freeSlotsFor(studioId: string, day: number): Interval[] {
  const spans = bookingsFor(studioId, day).map((b) => ({ start: b.startTs, end: b.endTs }));
  return freeIntervals(spans, day, timeZone());
}

export function standingRules(): StandingRule[] {
  return state.snapshot?.standingRules ?? [];
}

export function standingRulesFor(studioId: string): StandingRule[] {
  return standingRules()
    .filter((rule) => rule.studioId === studioId)
    .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

export function myDayRequests(): DayRequest[] {
  return (state.snapshot?.dayRequests ?? [])
    .filter((r) => r.requesterUserId === currentUserId())
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function dayRequest(id: string | null): DayRequest | undefined {
  return id === null ? undefined : state.snapshot?.dayRequests.find((r) => r.id === id);
}

export function preferences(): MemberPreferences {
  return state.snapshot?.preferences ?? DEFAULT_PREFERENCES;
}

export function pushPublicKey(): string {
  return state.snapshot?.pushPublicKey ?? "";
}

export function notifications(): AppNotification[] {
  return state.snapshot?.notifications ?? [];
}

export function unreadNotifications(): AppNotification[] {
  return notifications().filter((n) => n.readAt === null);
}

export function isDaySelected(day: number): boolean {
  return state.calendarSelection.includes(day);
}

export function toggleDaySelection(day: number): void {
  const selection = isDaySelected(day)
    ? state.calendarSelection.filter((value) => value !== day)
    : [...state.calendarSelection, day].sort((a, b) => a - b);
  update({ calendarSelection: selection });
}

export function clearDaySelection(): void {
  update({ calendarSelection: [], calendarSelecting: false });
}

export interface ReleasePreviewDay {
  day: number;
  bookings: Booking[];
  waiting: BookingRequest[];
}

export function releasePreview(studioId: string, days: number[]): ReleasePreviewDay[] {
  const me = currentUserId();
  const mayManage = isBookingManager();
  const requests = state.snapshot?.requests ?? [];

  return days.map((day) => {
    const bookings = bookingsFor(studioId, day)
      .filter((b) => b.ownerUserId === me || mayManage);
    const ids = new Set(bookings.map((b) => b.id));
    return {
      day,
      bookings,
      waiting: requests
        .filter((r) => r.status === "pending" && ids.has(r.bookingId))
        .sort((a, b) => a.createdAt - b.createdAt),
    };
  });
}

export function studiosByPriority(): Studio[] {
  const order = new Map(preferences().studioPriority.map((id, index) => [id, index]));
  return activeStudios().sort((a, b) => {
    const ra = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "en");
  });
}

export interface WindowAssessment {
  studio: Studio;
  free: boolean;
  requestable: boolean;
  mine: boolean;
  owners: string[];
}

export function assessWindow(startTs: number, endTs: number): WindowAssessment[] {
  const me = currentUserId();
  return studiosByPriority().map((studio) => {
    const overlapping = (state.snapshot?.bookings ?? [])
      .filter((b) => b.studioId === studio.id && b.startTs < endTs && b.endTs > startTs);
    const mine = overlapping.filter((b) => b.ownerUserId === me);
    const open = overlapping.filter((b) => b.state === "reserved" && b.ownerUserId !== me);
    return {
      studio,
      free: overlapping.length === 0,
      requestable: overlapping.length > 0 && mine.length === 0 && open.length === overlapping.length,
      mine: mine.length > 0,
      owners: Array.from(new Set(overlapping.map((b) => memberName(b.ownerUserId)))),
    };
  });
}

export function dayStateInWindow(studioId: string, window: Interval): DayState {
  const spans = (state.snapshot?.bookings ?? [])
    .filter((b) => b.studioId === studioId && b.startTs < window.end && b.endTs > window.start)
    .map((b) => ({ start: b.startTs, end: b.endTs, state: b.state }));
  return dayStateIn(spans, window);
}

export function standingHorizon(): number {
  return addDaysInZone(today(), STANDING_HORIZON_DAYS);
}

function addDaysInZone(ts: number, days: number): number {
  return addDays(ts, days, timeZone());
}
