// A made-up team for the demo at sr.tbor.app. Everything is generated in the browser on each visit;
// nothing is sent to a server and nothing is stored.
import type {
  ActivityEvent, AppNotification, Booking, BookingRequest, BookingState, DayRequest,
  StandingRule, Studio, TeamMember, TeamSnapshot,
} from "../domain/models";
import { DEFAULT_PREFERENCES, STANDING_HORIZON_DAYS } from "../domain/models";
import { addDays, isValidTimeZone, startOfDay, weekdayOf } from "../domain/time";

type Random = () => number;

function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const between = (random: Random, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

function shuffled<T>(random: Random, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const TEAM_FIRST = ["Linden", "Copper", "Morning", "East Wind", "Glass", "Birch", "River", "Lantern", "Harbour Light", "Quiet Hour"];
const TEAM_LAST = ["Studios", "Collective", "Rooms", "Atelier", "Music House", "Workshop"];

const ROOMS: ReadonlyArray<[string, string]> = [
  ["Studio A", "Grand piano, 38 m²"],
  ["Studio B", "Drum kit and amps"],
  ["Live Room", "Big room, high ceiling"],
  ["Mix Room", "Monitors and desk"],
  ["Booth", "Vocals and voice-over"],
  ["Dance Floor", "Sprung floor, mirrors"],
  ["Daylight Room", "Photo and video"],
  ["Small Room", "Lessons and practice"],
];

const NAMES = [
  "Ada", "Ben", "Clara", "Deniz", "Elif", "Finn", "Greta", "Hugo", "Ines", "Jonas",
  "Kira", "Luca", "Mira", "Noah", "Olga", "Paul", "Rosa", "Sami", "Tilda", "Yara",
];

const TITLES = [
  "Recording", "Rehearsal", "Mixing", "Lesson", "Band practice", "Podcast", "Photo shoot",
  "Choir", "Workshop", "Songwriting", "Editing", "Voice-over", "",
];

function demoTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && isValidTimeZone(zone)) return zone;
  } catch {
  }
  return "Europe/Berlin";
}

export function generateDemoSnapshot(seed: number = Math.floor(Math.random() * 2 ** 32)): TeamSnapshot {
  const random = seeded(seed);
  const timeZone = demoTimeZone();
  const now = Math.floor(Date.now() / 1000);
  const today = startOfDay(now, timeZone);
  let counter = 0;
  const id = (prefix: string) => `${prefix}-${(++counter).toString(36)}`;

  const studios: Studio[] = shuffled(random, ROOMS).slice(0, between(random, 3, 5)).map(([name, subtitle], index) => ({
    id: id("studio"), name, subtitle, sortOrder: index, isActive: true,
  }));

  const names = shuffled(random, NAMES).slice(0, between(random, 7, 11));
  const members: TeamMember[] = names.map((displayName, index) => ({
    userId: id("member"),
    displayName,
    role: index === 0 ? "owner" : index === 1 ? "admin" : "member",
    isActive: true,
    isPending: false,
    isPlaceholder: false,
    createdAt: now - between(random, 30, 400) * 86_400,
  }));
  members.push({
    userId: id("member"), displayName: `${pick(random, NAMES)} (guest)`, role: "member",
    isActive: false, isPending: false, isPlaceholder: true, createdAt: now - 20 * 86_400,
  });

  const active = members.filter((m) => m.isActive);
  const viewer = active[active.length - 1]!;
  const others = active.filter((m) => m.userId !== viewer.userId);

  const bookings: Booking[] = [];
  const taken = new Map<string, Array<[number, number]>>();
  const isFree = (studioId: string, start: number, end: number) =>
    !(taken.get(studioId) ?? []).some(([s, e]) => start < e && end > s);
  const add = (booking: Omit<Booking, "id" | "createdAt" | "updatedAt">): Booking | null => {
    if (!isFree(booking.studioId, booking.startTs, booking.endTs)) return null;
    const created = now - between(random, 1, 30) * 86_400;
    const full: Booking = { ...booking, id: id("booking"), createdAt: created, updatedAt: created };
    bookings.push(full);
    const list = taken.get(booking.studioId) ?? [];
    list.push([booking.startTs, booking.endTs]);
    taken.set(booking.studioId, list);
    return full;
  };

  const standingRules: StandingRule[] = [];
  for (let i = 0; i < between(random, 3, 5); i++) {
    const startMinute = between(random, 9, 15) * 60;
    standingRules.push({
      id: id("standing"),
      studioId: pick(random, studios).id,
      weekday: between(random, 1, 5),
      memberUserId: pick(random, others).userId,
      startMinute,
      endMinute: startMinute + between(random, 2, 4) * 60,
      state: "reserved",
      title: pick(random, TITLES.filter(Boolean)),
      isActive: true,
      createdAt: now - 60 * 86_400,
    });
  }

  for (let offset = -14; offset <= STANDING_HORIZON_DAYS; offset++) {
    const day = addDays(today, offset, timeZone);
    const weekday = weekdayOf(day, timeZone);
    for (const rule of standingRules) {
      if (rule.weekday !== weekday || offset < 0) continue;
      add({
        studioId: rule.studioId, ownerUserId: rule.memberUserId,
        startTs: day + rule.startMinute * 60, endTs: day + rule.endMinute * 60,
        title: rule.title, state: rule.state, origin: "standing", standingRuleId: rule.id, dayRequestId: null,
      });
    }

    const busy = offset >= 0 && offset < 21 ? 0.75 : 0.45;
    for (const studio of studios) {
      if (random() < 0.08) {
        add({
          studioId: studio.id, ownerUserId: pick(random, others).userId,
          startTs: day, endTs: addDays(day, 1, timeZone),
          title: pick(random, ["Production week", "Concert prep", "Shoot day"]), state: "occupied",
          origin: "manual", standingRuleId: null, dayRequestId: null,
        });
        continue;
      }
      for (let slot = 0; slot < 3; slot++) {
        if (random() > busy) continue;
        const startHour = pick(random, [9, 10, 12, 14, 16, 18, 19]);
        const start = day + (startHour * 60 + pick(random, [0, 30])) * 60;
        const end = start + between(random, 2, 8) * 1800;
        const state: BookingState = random() < 0.55 ? "reserved" : "occupied";
        add({
          studioId: studio.id,
          ownerUserId: random() < 0.15 ? viewer.userId : pick(random, others).userId,
          startTs: start, endTs: end, title: pick(random, TITLES), state,
          origin: "manual", standingRuleId: null, dayRequestId: null,
        });
      }
    }
  }

  const upcoming = (owner: (b: Booking) => boolean, state?: BookingState) =>
    bookings.filter((b) => b.startTs > now + 86_400 && owner(b) && (state === undefined || b.state === state));

  const requests: BookingRequest[] = [];
  const request = (booking: Booking, requester: TeamMember) => {
    requests.push({
      id: id("request"), bookingId: booking.id, studioId: booking.studioId,
      bookingOwnerUserId: booking.ownerUserId, requesterUserId: requester.userId,
      startTs: booking.startTs, endTs: booking.endTs, status: "pending", dayRequestId: null,
      createdAt: now - between(random, 1, 48) * 3600, answeredAt: null,
    });
  };
  const mine = upcoming((b) => b.ownerUserId === viewer.userId, "reserved");
  if (mine[0]) request(mine[0], pick(random, others));
  const theirs = upcoming((b) => b.ownerUserId !== viewer.userId, "reserved");
  for (const booking of shuffled(random, theirs).slice(0, 2)) {
    request(booking, random() < 0.5 ? viewer : pick(random, others.filter((m) => m.userId !== booking.ownerUserId)));
  }

  const requestDay = addDays(today, between(random, 3, 9), timeZone);
  const dayRequests: DayRequest[] = [{
    id: id("dayrequest"), requesterUserId: viewer.userId,
    startTs: requestDay + 10 * 3600, endTs: requestDay + 16 * 3600,
    scope: "cascade", status: "pending", grantedStudioId: null, provisionalBookingId: null,
    note: "Any room with a piano would be great.", createdAt: now - 5 * 3600, answeredAt: null,
  }];

  const someone = () => pick(random, others).displayName;
  const notifications: AppNotification[] = [
    { id: id("note"), kind: "requestCreated", title: "New request", body: `${someone()} asks for one of your bookings.`, createdAt: now - 3 * 3600, readAt: null },
    { id: id("note"), kind: "slotReleased", title: "A room came free", body: `${someone()} released ${pick(random, studios).name} for tomorrow.`, createdAt: now - 26 * 3600, readAt: now - 20 * 3600 },
    { id: id("note"), kind: "requestAccepted", title: "Request accepted", body: `${someone()} gave you the time you asked for.`, createdAt: now - 3 * 86_400, readAt: now - 3 * 86_400 },
  ];

  const activities: ActivityEvent[] = Array.from({ length: 12 }, (_, i) => ({
    id: id("activity"), kind: "bookingCreated" as const, actorUserId: pick(random, others).userId,
    message: `${someone()} booked ${pick(random, studios).name}.`, createdAt: now - (i + 1) * 5 * 3600,
  }));

  return {
    team: {
      id: "demo",
      name: `${pick(random, TEAM_FIRST)} ${pick(random, TEAM_LAST)}`,
      timeZone,
      createdAt: now - 400 * 86_400,
      joinMode: "approval",
    },
    members,
    studios,
    bookings: bookings.sort((a, b) => a.startTs - b.startTs),
    requests,
    dayRequests,
    standingRules,
    notifications,
    preferences: { ...DEFAULT_PREFERENCES, studioPriority: studios.map((s) => s.id) },
    activities,
    currentUserId: viewer.userId,
    role: "member",
    canWrite: true,
    pushPublicKey: "",
    fetchedAt: now,
  };
}
