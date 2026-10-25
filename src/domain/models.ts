export type MemberRole = "member" | "admin" | "owner";
export type MemberStatus = "active" | "pending" | "blocked";
export type RequestStatus = "pending" | "accepted" | "declined" | "cancelled";

export type JoinMode = "closed" | "view" | "approval";

export type BookingState = "reserved" | "occupied";

export type BookingOrigin = "manual" | "standing" | "provisional";

export type DayState = "free" | "partial" | "reserved" | "occupied";

export type ActivityKind =
  | "bookingCreated" | "bookingChanged" | "bookingDeleted" | "bookingState"
  | "requestCreated" | "requestAccepted" | "requestDeclined"
  | "studioCreated" | "studioChanged" | "memberChanged"
  | "standingChanged";

export type NotificationKind =
  | "requestCreated" | "requestAccepted" | "requestDeclined"
  | "dayRequestFulfilled" | "dayRequestDeclined"
  | "slotReleased"
  | "bookingReleasedByAdmin";

export interface StudioTeam {
  id: string;
  name: string;
  timeZone: string;
  createdAt: number;
  joinMode: JoinMode;
}

export interface TeamMember {
  userId: string;
  displayName: string;
  role: MemberRole;
  isActive: boolean;
  isPending: boolean;
  isPlaceholder: boolean;
  createdAt: number;
}

export interface Studio {
  id: string;
  name: string;
  subtitle: string;
  sortOrder: number;
  isActive: boolean;
}

export interface Booking {
  id: string;
  studioId: string;
  ownerUserId: string;
  startTs: number;
  endTs: number;
  title: string;
  state: BookingState;
  origin: BookingOrigin;
  standingRuleId: string | null;
  dayRequestId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BookingRequest {
  id: string;
  bookingId: string;
  studioId: string;
  bookingOwnerUserId: string;
  requesterUserId: string;
  startTs: number;
  endTs: number;
  status: RequestStatus;
  dayRequestId: string | null;
  createdAt: number;
  answeredAt: number | null;
}

export interface StandingRule {
  id: string;
  studioId: string;
  weekday: number;
  memberUserId: string;
  startMinute: number;
  endMinute: number;
  state: BookingState;
  title: string;
  isActive: boolean;
  createdAt: number;
}

export type DayRequestScope = "single" | "cascade";
export type DayRequestStatus = "pending" | "fulfilled" | "declined" | "cancelled";

export interface DayRequest {
  id: string;
  requesterUserId: string;
  startTs: number;
  endTs: number;
  scope: DayRequestScope;
  status: DayRequestStatus;
  grantedStudioId: string | null;
  provisionalBookingId: string | null;
  note: string;
  createdAt: number;
  answeredAt: number | null;
}

export interface MemberPreferences {
  notifyEnabled: boolean;
  notifyVibrate: boolean;
  studioPriority: string[];
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
}

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  actorUserId: string;
  message: string;
  createdAt: number;
}

export interface TeamSnapshot {
  team: StudioTeam;
  members: TeamMember[];
  studios: Studio[];
  bookings: Booking[];
  requests: BookingRequest[];
  dayRequests: DayRequest[];
  standingRules: StandingRule[];
  notifications: AppNotification[];
  preferences: MemberPreferences;
  activities: ActivityEvent[];
  currentUserId: string;
  role: MemberRole;
  canWrite: boolean;
  pushPublicKey: string;
  fetchedAt: number;
}

export function memberStatus(member: Pick<TeamMember, "isActive" | "isPending">): MemberStatus {
  if (member.isActive) return "active";
  return member.isPending ? "pending" : "blocked";
}

export const PLACEHOLDER_HINT = "External, no access to the app";

export const MEMBER_STATUS_TITLE: Record<MemberStatus, string> = {
  active: "Active",
  pending: "Waiting for approval",
  blocked: "Blocked",
};

export const ROLE_TITLE: Record<MemberRole, string> = {
  member: "Member",
  admin: "Admin",
  owner: "Owner",
};

export const BOOKING_STATE_TITLE: Record<BookingState, string> = {
  reserved: "Reserved",
  occupied: "Occupied",
};

export const BOOKING_STATE_HINT: Record<BookingState, string> = {
  reserved: "Probably taken. Others may request the time range.",
  occupied: "Firmly taken. Requests are not possible for this time range.",
};

export const DAY_STATE_TITLE: Record<DayState, string> = {
  free: "Free",
  partial: "Partly free",
  reserved: "Reserved",
  occupied: "Occupied",
};

export const DAY_STATE_HINT: Record<DayState, string> = {
  free: "The whole day is free. Anyone can book it directly.",
  partial: "Part of the day is taken, the rest can be booked directly.",
  reserved: "The day is reserved. You can request it.",
  occupied: "The day is occupied. Requests are not possible here.",
};

export const WEEKDAY_TITLE = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function isWeekendDay(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

export const DEFAULT_PREFERENCES: MemberPreferences = {
  notifyEnabled: true,
  notifyVibrate: true,
  studioPriority: [],
};

export const LIMITS = {
  joinableMembers: 100,
  maximumStudios: 200,
  maximumBookings: 10_000,
  maximumRequests: 10_000,
  maximumStandingRules: 400,
  maximumReleaseDays: 62,
  maximumPushSubscriptions: 10,
  visibleActivities: 500,
  visibleNotifications: 50,
} as const;

export const STANDING_HORIZON_DAYS = 56;
