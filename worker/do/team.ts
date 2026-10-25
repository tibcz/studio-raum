import { DurableObject } from "cloudflare:workers";

import { StudioRaumError, encodeErrorForRpc, fail } from "../../src/domain/errors";
import { allows, canManageBookings, type Permission } from "../../src/domain/authorization";
import {
  DEFAULT_PREFERENCES, LIMITS, STANDING_HORIZON_DAYS, WEEKDAY_TITLE, memberStatus,
  type ActivityKind, type AppNotification, type Booking, type BookingOrigin,
  type BookingRequest, type BookingState, type DayRequest, type DayRequestScope,
  type JoinMode, type MemberPreferences, type MemberRole, type NotificationKind,
  type StandingRule, type Studio, type StudioTeam, type TeamMember, type TeamSnapshot,
} from "../../src/domain/models";
import {
  MAXIMUM_DURATION, gapsIn, roundedDownToSlot, slotsBetween, validateRange,
} from "../../src/domain/booking-rules";
import { formatDayTitle, formatTimeRange } from "../../src/domain/format";
import { addDays, isValidTimeZone, startOfDay, weekdayOf, zonedParts, zonedTimestamp } from "../../src/domain/time";
import { TEXT_LIMITS, requiredText, sanitizedText } from "../../src/domain/sanitize";
import {
  hashSecret, hashToken, newId, newJoinSecret, newPersonalSecret, newSessionToken,
  timingSafeEqual,
} from "../security/secrets";
import { isBase64UrlOfLength, sendPush, vapidConfigFrom, type VapidConfig } from "../security/webpush";
import { migrate } from "./schema";
import type { RateGateDO } from "./rate-gate";
import type { InstanceDO } from "./instance";

export interface Env {
  TEAM: DurableObjectNamespace<StudioTeamDO>;
  RATE_GATE: DurableObjectNamespace<RateGateDO>;
  INSTANCE: DurableObjectNamespace<InstanceDO>;
  // Optional: without them the copy generates its own keys on first start (worker/do/instance.ts).
  SECRET_PEPPER?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  // Required to create the team of a fresh copy, chosen in the Deploy to Cloudflare form.
  SETUP_PASSWORD?: string;
  // How many teams one copy may hold. Default 1, so a copy never turns into a public service.
  MAX_TEAMS?: string;
}

export interface ServerKeys {
  pepper: string;
  vapid: VapidConfig | null;
}

// The pepper and push keys: from the environment if set there, otherwise generated once per copy.
export async function serverKeys(env: Env): Promise<ServerKeys> {
  if (env.SECRET_PEPPER) return { pepper: env.SECRET_PEPPER, vapid: vapidConfigFrom(env) };
  const instance = env.INSTANCE.getByName("instance");
  const [secrets, status] = await Promise.all([instance.secrets(), instance.status(1)]);
  return {
    pepper: secrets.pepper,
    vapid: vapidConfigFrom({
      VAPID_PUBLIC_KEY: secrets.vapidPublicKey,
      VAPID_PRIVATE_KEY: secrets.vapidPrivateKey,
      VAPID_SUBJECT: env.VAPID_SUBJECT ?? status.operator?.email,
    }),
  };
}

const SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;
const SESSION_TOUCH_SECONDS = 10 * 60;

const RATE_WINDOW_SECONDS = 15 * 60;
const RATE_MAX_ATTEMPTS = 10;

const DAY_REQUEST_HISTORY_SECONDS = 14 * 24 * 60 * 60;

interface MemberRow {
  [key: string]: SqlStorageValue;
  user_id: string; display_name: string; role: MemberRole;
  is_active: number; is_pending: number; can_write: number; created_at: number;
  is_placeholder: number;
}
interface BookingRow {
  [key: string]: SqlStorageValue;
  id: string; studio_id: string; owner_user_id: string; start_ts: number;
  end_ts: number; title: string; created_at: number; updated_at: number;
  state: BookingState; origin: BookingOrigin;
  standing_rule_id: string | null; day_request_id: string | null;
}
interface RequestRow {
  [key: string]: SqlStorageValue;
  id: string; booking_id: string; studio_id: string; booking_owner_user_id: string;
  requester_user_id: string; start_ts: number; end_ts: number;
  status: BookingRequest["status"]; created_at: number; answered_at: number | null;
  day_request_id: string | null; priority: number;
}
interface StudioRow {
  [key: string]: SqlStorageValue;
  id: string; name: string; subtitle: string; sort_order: number; is_active: number;
}
interface TeamRow {
  [key: string]: SqlStorageValue;
  id: string; team_ref: string; name: string; time_zone: string; created_at: number;
  join_mode: JoinMode; join_secret_hash: string | null; join_secret_rotated_at: number | null;
}
interface StandingRuleRow {
  [key: string]: SqlStorageValue;
  id: string; studio_id: string; weekday: number; member_user_id: string;
  start_minute: number; end_minute: number; state: BookingState; title: string;
  is_active: number; created_at: number;
}
interface DayRequestRow {
  [key: string]: SqlStorageValue;
  id: string; requester_user_id: string; start_ts: number; end_ts: number;
  scope: DayRequestScope; status: DayRequest["status"]; granted_studio_id: string | null;
  provisional_booking_id: string | null; note: string;
  created_at: number; answered_at: number | null;
}
interface PushRow {
  [key: string]: SqlStorageValue;
  id: string; user_id: string; endpoint: string; p256dh: string; auth: string; created_at: number;
}
interface NotificationRow {
  [key: string]: SqlStorageValue;
  id: string; user_id: string; kind: NotificationKind; title: string; body: string;
  created_at: number; read_at: number | null;
}

export interface Caller {
  userId: string;
  member: TeamMember;
  canWrite: boolean;
}

export interface CreateTeamInput {
  teamRef: string;
  name: string;
  timeZone: string;
  ownerName: string;
}

export interface CreatedTeam {
  teamRef: string;
  userId: string;
  personalSecret: string;
  joinSecret: string;
  sessionToken: string;
}

export interface JoinResult {
  userId: string;
  personalSecret: string;
  sessionToken: string;
  status: "active" | "pending" | "readOnly";
}

export interface BookingDraft {
  studioId: string;
  startTs: number;
  endTs: number;
  title: string;
  state?: BookingState;
}

export interface StandingRuleDraft {
  studioId: string;
  weekday: number;
  memberUserId: string;
  startMinute: number;
  endMinute: number;
  state: BookingState;
  title: string;
  isActive: boolean;
}

export interface DayRequestDraft {
  startTs: number;
  endTs: number;
  studioId: string | null;
  note: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface PushPayload {
  title: string;
  body: string;
  tag: string;
  vibrate: boolean;
}

export class StudioTeamDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private pendingPush: Array<{ userId: string; payload: PushPayload }> = [];
  private keys: ServerKeys = { pepper: "", vapid: null };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.sql);
      this.keys = await serverKeys(env);
    });
  }

  async createTeam(input: CreateTeamInput): Promise<CreatedTeam> {
    return this.guard(async () => {
      if (this.teamRowOrNull() !== null) fail("conflict", "This team already exists.");

      const name = requiredText(input.name, TEXT_LIMITS.teamName, 2);
      const ownerName = requiredText(input.ownerName, TEXT_LIMITS.displayName, 2);
      const timeZone = isValidTimeZone(input.timeZone) ? input.timeZone : "Europe/Berlin";

      const personalSecret = newPersonalSecret(input.teamRef);
      const joinSecret = newJoinSecret(input.teamRef);
      const sessionToken = newSessionToken();
      const [secretHash, joinHash, tokenHash] = await Promise.all([
        this.hash(personalSecret),
        this.hash(joinSecret),
        hashToken(this.keys.pepper, sessionToken),
      ]);

      const now = this.now();
      const userId = newId();

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO team (id, team_ref, name, time_zone, created_at, join_mode,
                             join_secret_hash, join_secret_rotated_at)
           VALUES (?, ?, ?, ?, ?, 'approval', ?, ?)`,
          newId(), input.teamRef, name, timeZone, now, joinHash, now,
        );
        this.sql.exec(
          `INSERT INTO members (user_id, display_name, role, is_active, is_pending,
                                can_write, created_at, secret_hash)
           VALUES (?, ?, 'owner', 1, 0, 1, ?, ?)`,
          userId, ownerName, now, secretHash,
        );
        this.ensurePreferences(userId);
        const defaults: ReadonlyArray<readonly [string, string]> = [
          ["Studio A", "Recording"], ["Studio B", "Production"], ["Studio C", "Writing"],
        ];
        defaults.forEach(([studioName, subtitle], index) => {
          this.sql.exec(
            "INSERT INTO studios (id, name, subtitle, sort_order, is_active) VALUES (?, ?, ?, ?, 1)",
            newId(), studioName, subtitle, index,
          );
        });
        this.insertSession(tokenHash, userId, now);
      });

      return { teamRef: input.teamRef, userId, personalSecret, joinSecret, sessionToken };
    });
  }

  async join(joinSecretInput: string, displayName: string, clientKey: string): Promise<JoinResult> {
    return this.guard(async () => {
      this.enforceRateLimit(`join:${clientKey}`);

      const team = this.teamRow();
      if (team.join_mode === "closed") fail("joinClosed");

      const name = requiredText(displayName, TEXT_LIMITS.displayName, 2);
      const offered = await this.hash(joinSecretInput);
      if (team.join_secret_hash === null || !timingSafeEqual(team.join_secret_hash, offered)) {
        this.recordFailedAttempt(`join:${clientKey}`);
        fail("invalidSecret");
      }

      const count = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM members",
      ).one().count;
      if (count >= LIMITS.joinableMembers) fail("teamFull");

      const readOnly = team.join_mode === "view";
      const personalSecret = newPersonalSecret(team.team_ref);
      const sessionToken = newSessionToken();
      const [secretHash, tokenHash] = await Promise.all([
        this.hash(personalSecret),
        hashToken(this.keys.pepper, sessionToken),
      ]);

      const now = this.now();
      const userId = newId();

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO members (user_id, display_name, role, is_active, is_pending,
                                can_write, created_at, secret_hash)
           VALUES (?, ?, 'member', ?, ?, ?, ?, ?)`,
          userId, name,
          readOnly ? 1 : 0,
          readOnly ? 0 : 1,
          readOnly ? 0 : 1,
          now, secretHash,
        );
        this.ensurePreferences(userId);
        this.insertSession(tokenHash, userId, now);
        this.clearRateLimit(`join:${clientKey}`);
      });

      this.broadcast();
      return {
        userId, personalSecret, sessionToken,
        status: readOnly ? "readOnly" : "pending",
      };
    });
  }

  async openSession(personalSecret: string, clientKey: string): Promise<{ userId: string; sessionToken: string }> {
    return this.guard(async () => {
      this.enforceRateLimit(`login:${clientKey}`);

      const offered = await this.hash(personalSecret);
      const row = this.sql.exec<{ user_id: string; is_active: number; is_pending: number }>(
        "SELECT user_id, is_active, is_pending FROM members WHERE secret_hash = ? AND is_placeholder = 0",
        offered,
      ).toArray()[0];

      if (!row) {
        this.recordFailedAttempt(`login:${clientKey}`);
        fail("invalidSecret");
      }
      if (row.is_active === 0 && row.is_pending === 0) fail("memberDisabled");

      const sessionToken = newSessionToken();
      const tokenHash = await hashToken(this.keys.pepper, sessionToken);
      const now = this.now();

      this.ctx.storage.transactionSync(() => {
        this.pruneSessions(now);
        this.insertSession(tokenHash, row.user_id, now);
        this.clearRateLimit(`login:${clientKey}`);
      });

      return { userId: row.user_id, sessionToken };
    });
  }

  async closeSession(sessionToken: string): Promise<void> {
    const tokenHash = await hashToken(this.keys.pepper, sessionToken);
    this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  async resolveSession(sessionToken: string): Promise<{ userId: string } | null> {
    const tokenHash = await hashToken(this.keys.pepper, sessionToken);
    const now = this.now();
    const row = this.sql.exec<{ user_id: string; last_seen_at: number; expires_at: number; created_at: number }>(
      "SELECT user_id, last_seen_at, expires_at, created_at FROM sessions WHERE token_hash = ?",
      tokenHash,
    ).toArray()[0];

    if (!row) return null;
    if (row.expires_at <= now || row.created_at + SESSION_ABSOLUTE_SECONDS <= now) {
      this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
      return null;
    }
    if (now - row.last_seen_at > SESSION_TOUCH_SECONDS) {
      this.sql.exec(
        "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
        now, now + SESSION_IDLE_SECONDS, tokenHash,
      );
    }
    return { userId: row.user_id };
  }

  async snapshot(userId: string): Promise<TeamSnapshot> {
    return this.guard(async () => {
      const caller = this.caller(userId);
      if (!caller.member.isActive) {
        fail(memberStatus(caller.member) === "pending" ? "memberPending" : "memberDisabled");
      }
      if (this.materializeStanding() > 0) this.broadcast();
      return this.buildSnapshot(caller);
    });
  }

  async exportData(userId: string): Promise<unknown> {
    return this.guard(async () => {
      const caller = this.caller(userId);
      if (!caller.member.isActive) fail("permissionDenied");
      const snapshot = this.buildSnapshot(caller);
      return { exportedAt: new Date(this.now() * 1000).toISOString(), ...snapshot };
    });
  }

  async createBooking(userId: string, draft: BookingDraft): Promise<Booking> {
    return this.guard(async () => {
      const caller = this.require(userId, "participate");
      const studio = this.requireActiveStudio(draft.studioId);
      const range = this.validatedRange(draft.startTs, draft.endTs);
      const slots = slotsBetween(range.startTs, range.endTs);
      const title = sanitizedText(draft.title, TEXT_LIMITS.title);
      const state = this.validatedState(draft.state, "occupied");

      const total = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM bookings").one().count;
      if (total >= LIMITS.maximumBookings) fail("dataLimitExceeded");

      const now = this.now();
      const bookingId = newId();
      const timeZone = this.teamRow().time_zone;

      this.ctx.storage.transactionSync(() => {
        this.assertSlotsFree(studio.id, slots);
        this.insertBooking({
          id: bookingId, studioId: studio.id, ownerUserId: userId,
          startTs: range.startTs, endTs: range.endTs, title, state,
          origin: "manual", standingRuleId: null, dayRequestId: null,
          createdAt: now, updatedAt: now,
        }, slots);
        this.logActivity("bookingCreated", userId, [],
          `${caller.member.displayName} booked ${studio.name} for ` +
          `${formatTimeRange(range.startTs, range.endTs, timeZone)}.`);
      });

      this.broadcast();
      return this.toBooking(this.bookingRow(bookingId));
    });
  }

  async updateBooking(userId: string, bookingId: string, draft: BookingDraft): Promise<Booking> {
    return this.guard(async () => {
      const caller = this.require(userId, "participate");
      const current = this.bookingRow(bookingId);
      if (current.owner_user_id !== userId && !canManageBookings(caller.member.role)) {
        fail("permissionDenied");
      }
      const studio = this.requireActiveStudio(draft.studioId);
      const range = this.validatedRange(draft.startTs, draft.endTs);
      const title = sanitizedText(draft.title, TEXT_LIMITS.title);
      const state = this.validatedState(draft.state, current.state);

      const oldSlots = slotsBetween(current.start_ts, current.end_ts);
      const newSlots = slotsBetween(range.startTs, range.endTs);
      const studioChanged = current.studio_id !== studio.id;
      const oldSet = new Set(oldSlots);
      const newSet = new Set(newSlots);
      const toAdd = studioChanged ? newSlots : newSlots.filter((s) => !oldSet.has(s));
      const toRemove = studioChanged ? oldSlots : oldSlots.filter((s) => !newSet.has(s));

      const now = this.now();
      const timeZone = this.teamRow().time_zone;

      this.ctx.storage.transactionSync(() => {
        for (const slot of toRemove) {
          this.sql.exec(
            "DELETE FROM booking_locks WHERE studio_id = ? AND slot_ts = ? AND booking_id = ?",
            current.studio_id, slot, bookingId,
          );
        }
        this.assertSlotsFree(studio.id, toAdd);
        this.sql.exec(
          `UPDATE bookings SET studio_id = ?, start_ts = ?, end_ts = ?, title = ?, state = ?, updated_at = ?
           WHERE id = ?`,
          studio.id, range.startTs, range.endTs, title, state, now, bookingId,
        );
        this.insertLocks(studio.id, toAdd, bookingId, current.owner_user_id);
        this.dropStaleRequests(bookingId);
        this.logActivity("bookingChanged", userId, [current.owner_user_id],
          `${caller.member.displayName} changed the booking in ${studio.name} to ` +
          `${formatTimeRange(range.startTs, range.endTs, timeZone)}.`);
      });

      for (const id of this.affectedDayRequests(bookingId, current.day_request_id)) {
        this.settleDayRequest(id);
      }
      this.broadcast();
      return this.toBooking(this.bookingRow(bookingId));
    });
  }

  async setBookingState(userId: string, bookingId: string, state: BookingState): Promise<Booking> {
    return this.guard(async () => {
      const caller = this.require(userId, "participate");
      const current = this.bookingRow(bookingId);
      if (current.owner_user_id !== userId && !canManageBookings(caller.member.role)) {
        fail("permissionDenied");
      }
      const wanted = this.validatedState(state, current.state);
      const studioName = this.studioName(current.studio_id);

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?", wanted, this.now(), bookingId,
        );
        if (wanted === "occupied") this.declinePendingRequestsFor(bookingId, userId);
        this.logActivity("bookingState", userId, [current.owner_user_id],
          wanted === "occupied"
            ? `${caller.member.displayName} marked ${studioName} as occupied.`
            : `${caller.member.displayName} opened ${studioName} for requests.`);
      });

      this.broadcast();
      return this.toBooking(this.bookingRow(bookingId));
    });
  }

  async deleteBooking(userId: string, bookingId: string): Promise<void> {
    return this.guard(async () => {
      const caller = this.require(userId, "participate");
      const current = this.bookingRow(bookingId);
      if (current.owner_user_id !== userId && !canManageBookings(caller.member.role)) {
        fail("permissionDenied");
      }

      this.releaseBooking(current, caller);
      this.broadcast();
    });
  }

  async releaseDays(
    userId: string, studioId: string, dayStarts: number[],
  ): Promise<{ released: number; granted: number }> {
    return this.guard(async () => {
      const caller = this.require(userId, "participate");
      const studio = this.requireActiveStudio(studioId);
      const days = this.validatedDays(dayStarts);
      const mayManage = canManageBookings(caller.member.role);
      const timeZone = this.teamRow().time_zone;

      let released = 0;
      let granted = 0;

      for (const day of days) {
        const end = addDays(day, 1, timeZone);
        for (const booking of this.bookingsOverlapping(studio.id, day, end)) {
          if (booking.owner_user_id !== userId && !mayManage) continue;
          const outcome = this.releaseBooking(booking, caller);
          if (outcome.released) released += 1;
          granted += outcome.granted;
        }
      }

      this.broadcast();
      return { released, granted };
    });
  }

  private releaseBooking(booking: BookingRow, actor: Caller): { released: boolean; granted: number } {
    const stillThere = this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM bookings WHERE id = ?", booking.id,
    ).one().count;
    if (stillThere === 0) return { released: false, granted: 0 };

    const studioName = this.studioName(booking.studio_id);
    const owner = booking.owner_user_id;
    const timeZone = this.teamRow().time_zone;

    const queue = this.sql.exec<RequestRow>(
      `SELECT * FROM booking_requests
       WHERE booking_id = ? AND status = 'pending'
       ORDER BY created_at ASC, rowid ASC`,
      booking.id,
    ).toArray();

    let granted = 0;
    const winners = new Set<string>();
    for (const request of queue) {
      if (this.grantRequest(request, actor, this.memberName(request.requester_user_id))) {
        granted += 1;
        winners.add(request.requester_user_id);
      }
    }

    this.ctx.storage.transactionSync(() => {
      for (const request of queue) {
        if (winners.has(request.requester_user_id)) continue;
        const stillFree = this.bookingsOverlapping(
          booking.studio_id, request.start_ts, request.end_ts,
        ).length === 0;

        this.notify(request.requester_user_id, "slotReleased",
          stillFree ? `${studioName} is free now` : `${studioName} has been taken`,
          `${formatDayTitle(request.start_ts, timeZone)}, ` +
          `${formatTimeRange(request.start_ts, request.end_ts, timeZone)}: ` +
          (stillFree
            ? "The room is free now, you can book it directly."
            : "Someone was ahead of you in the queue."));
      }
      this.sql.exec(
        "UPDATE booking_requests SET status = 'cancelled', answered_at = ? WHERE booking_id = ? AND status = 'pending'",
        this.now(), booking.id,
      );

      for (const rest of this.bookingsOverlapping(booking.studio_id, booking.start_ts, booking.end_ts)) {
        if (rest.owner_user_id === owner) this.removeBooking(rest.id);
      }

      this.logActivity("bookingDeleted", actor.userId, [owner],
        `${actor.member.displayName} released the booking in ${studioName}.`);

      if (owner !== actor.userId) {
        this.notify(owner, "bookingReleasedByAdmin",
          `${studioName} was released`,
          `${actor.member.displayName} released your booking on ` +
          `${formatDayTitle(booking.start_ts, timeZone)}.`);
      }
    });

    for (const id of this.affectedDayRequests(booking.id, booking.day_request_id)) {
      this.settleDayRequest(id);
    }
    return { released: true, granted };
  }

  async createStandingRule(userId: string, draft: StandingRuleDraft): Promise<StandingRule> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const rule = this.validatedRule(draft, null);

      const count = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM standing_rules",
      ).one().count;
      if (count >= LIMITS.maximumStandingRules) fail("dataLimitExceeded");

      const id = newId();
      const now = this.now();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO standing_rules
             (id, studio_id, weekday, member_user_id, start_minute, end_minute, state, title, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, rule.studioId, rule.weekday, rule.memberUserId, rule.startMinute, rule.endMinute,
          rule.state, rule.title, rule.isActive ? 1 : 0, now,
        );
        this.logActivity("standingChanged", userId, [rule.memberUserId],
          `${caller.member.displayName} set ${this.memberName(rule.memberUserId)} ` +
          `to ${this.studioName(rule.studioId)} every ${WEEKDAY_TITLE[rule.weekday]}.`);
      });

      this.materializeStanding(true);
      this.broadcast();
      return this.toStandingRule(this.standingRuleRow(id));
    });
  }

  async updateStandingRule(userId: string, ruleId: string, draft: StandingRuleDraft): Promise<StandingRule> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const existing = this.standingRuleRow(ruleId);
      const rule = this.validatedRule(draft, ruleId);

      this.ctx.storage.transactionSync(() => {
        this.clearFutureStanding(ruleId);
        this.sql.exec(
          `UPDATE standing_rules SET studio_id = ?, weekday = ?, member_user_id = ?,
             start_minute = ?, end_minute = ?, state = ?, title = ?, is_active = ?
           WHERE id = ?`,
          rule.studioId, rule.weekday, rule.memberUserId, rule.startMinute, rule.endMinute,
          rule.state, rule.title, rule.isActive ? 1 : 0, ruleId,
        );
        this.logActivity("standingChanged", userId, [rule.memberUserId, existing.member_user_id],
          `${caller.member.displayName} changed the standing booking for ` +
          `${this.studioName(rule.studioId)}.`);
      });

      this.materializeStanding(true);
      this.broadcast();
      return this.toStandingRule(this.standingRuleRow(ruleId));
    });
  }

  async deleteStandingRule(userId: string, ruleId: string): Promise<void> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const existing = this.standingRuleRow(ruleId);

      this.ctx.storage.transactionSync(() => {
        this.clearFutureStanding(ruleId);
        this.sql.exec("DELETE FROM standing_marks WHERE rule_id = ?", ruleId);
        this.sql.exec("DELETE FROM standing_rules WHERE id = ?", ruleId);
        this.logActivity("standingChanged", userId, [existing.member_user_id],
          `${caller.member.displayName} removed the standing booking on ` +
          `${WEEKDAY_TITLE[existing.weekday]} in ${this.studioName(existing.studio_id)}.`);
      });

      this.broadcast();
    });
  }

  async createRequest(userId: string, bookingId: string, startTs: number, endTs: number): Promise<BookingRequest> {
    return this.guard(async () => {
      const caller = this.require(userId, "participate");
      const range = this.validatedRange(startTs, endTs);
      const booking = this.bookingRow(bookingId);

      if (
        booking.owner_user_id === userId ||
        range.startTs < booking.start_ts ||
        range.endTs > booking.end_ts
      ) {
        fail("invalidTime");
      }
      if (booking.state === "occupied") fail("requestNotAllowed");

      const total = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM booking_requests",
      ).one().count;
      if (total >= LIMITS.maximumRequests) fail("dataLimitExceeded");

      const id = await this.stableId(`${bookingId}|${userId}|${range.startTs}|${range.endTs}`);
      const existing = this.sql.exec<RequestRow>(
        "SELECT * FROM booking_requests WHERE id = ?", id,
      ).toArray()[0];
      if (existing && existing.status === "pending") {
        fail("conflict", "This request is already open.");
      }

      const timeZone = this.teamRow().time_zone;
      this.ctx.storage.transactionSync(() => {
        this.insertRequest(id, booking, userId, range.startTs, range.endTs, null, 0);
        this.logActivity("requestCreated", userId, [booking.owner_user_id],
          `${caller.member.displayName} requested ${this.studioName(booking.studio_id)} for ` +
          `${formatTimeRange(range.startTs, range.endTs, timeZone)}.`);
        this.notifyRequestCreated(booking, caller.member.displayName, range.startTs, range.endTs, timeZone);
      });

      this.broadcast();
      return this.toRequest(this.sql.exec<RequestRow>(
        "SELECT * FROM booking_requests WHERE id = ?", id,
      ).one());
    });
  }

  async resolveRequest(
    userId: string, requestId: string, accept: boolean, markCertain = false,
  ): Promise<void> {
    return this.guard(async () => {
      const caller = this.require(userId, "participate");
      const request = this.sql.exec<RequestRow>(
        "SELECT * FROM booking_requests WHERE id = ?", requestId,
      ).toArray()[0];
      if (!request || request.status !== "pending") fail("requestNoLongerAvailable");
      if (request.requester_user_id === userId) fail("permissionDenied");
      if (request.booking_owner_user_id !== userId && !canManageBookings(caller.member.role)) {
        fail("permissionDenied");
      }

      const now = this.now();
      const timeZone = this.teamRow().time_zone;
      const studioName = this.studioName(request.studio_id);
      const requesterName = this.memberName(request.requester_user_id);

      if (!accept) {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            "UPDATE booking_requests SET status = 'declined', answered_at = ? WHERE id = ?",
            now, requestId,
          );
          if (markCertain) {
            this.sql.exec(
              "UPDATE bookings SET state = 'occupied', updated_at = ? WHERE id = ?", now, request.booking_id,
            );
            this.declinePendingRequestsFor(request.booking_id, userId);
          }
          this.logActivity("requestDeclined", userId, [request.requester_user_id],
            `${caller.member.displayName} declined the request from ${requesterName} for ${studioName}.`);
          this.notify(request.requester_user_id, "requestDeclined",
            `${studioName} stays occupied`,
            `${caller.member.displayName} declined your request for ` +
            `${formatTimeRange(request.start_ts, request.end_ts, timeZone)}.`);
        });
        if (request.day_request_id) this.settleDayRequest(request.day_request_id);
        this.broadcast();
        return;
      }

      if (!this.grantRequest(request, caller, requesterName)) {
        fail("requestNoLongerAvailable");
      }

      if (request.day_request_id) this.settleDayRequest(request.day_request_id);
      this.broadcast();
    });
  }

  private grantRequest(request: RequestRow, actor: Caller, requesterName: string): boolean {
    const now = this.now();
    const timeZone = this.teamRow().time_zone;
    const studioName = this.studioName(request.studio_id);

    const original = this.sql.exec<BookingRow>(
      "SELECT * FROM bookings WHERE id = ?", request.booking_id,
    ).toArray()[0];
    if (
      !original ||
      original.owner_user_id !== request.booking_owner_user_id ||
      request.start_ts < original.start_ts ||
      request.end_ts > original.end_ts
    ) {
      return false;
    }

    const requester = this.memberRowOrNull(request.requester_user_id);
    if (!requester || requester.is_active !== 1 || requester.can_write !== 1) {
      return false;
    }

    const transfersEverything =
      request.start_ts === original.start_ts && request.end_ts === original.end_ts;

    this.ctx.storage.transactionSync(() => {
      let transferBookingId = original.id;
      let trailingBookingId: string | null = null;

      if (transfersEverything) {
        this.sql.exec(
          `UPDATE bookings SET owner_user_id = ?, state = 'occupied', origin = 'manual',
             standing_rule_id = NULL, updated_at = ? WHERE id = ?`,
          request.requester_user_id, now, original.id,
        );
        this.sql.exec("UPDATE standing_marks SET booking_id = NULL WHERE booking_id = ?", original.id);
      } else {
        transferBookingId = newId();
        this.sql.exec(
          `INSERT INTO bookings (id, studio_id, owner_user_id, start_ts, end_ts, title,
                                 state, origin, standing_rule_id, day_request_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'occupied', 'manual', NULL, NULL, ?, ?)`,
          transferBookingId, original.studio_id, request.requester_user_id,
          request.start_ts, request.end_ts, original.title, now, now,
        );

        if (request.start_ts > original.start_ts) {
          this.sql.exec(
            "UPDATE bookings SET end_ts = ?, updated_at = ? WHERE id = ?",
            request.start_ts, now, original.id,
          );
        } else {
          this.sql.exec(
            "UPDATE bookings SET start_ts = ?, updated_at = ? WHERE id = ?",
            request.end_ts, now, original.id,
          );
        }

        if (request.start_ts > original.start_ts && request.end_ts < original.end_ts) {
          trailingBookingId = newId();
          this.sql.exec(
            `INSERT INTO bookings (id, studio_id, owner_user_id, start_ts, end_ts, title,
                                   state, origin, standing_rule_id, day_request_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            trailingBookingId, original.studio_id, original.owner_user_id,
            request.end_ts, original.end_ts, original.title,
            original.state, original.origin, original.standing_rule_id, now, now,
          );
        }
      }

      this.sql.exec(
        `UPDATE booking_locks SET booking_id = ?, owner_user_id = ?
         WHERE booking_id = ? AND slot_ts >= ? AND slot_ts < ?`,
        transferBookingId, request.requester_user_id, original.id, request.start_ts, request.end_ts,
      );
      if (trailingBookingId !== null) {
        this.sql.exec(
          "UPDATE booking_locks SET booking_id = ? WHERE booking_id = ? AND slot_ts >= ?",
          trailingBookingId, original.id, request.end_ts,
        );
      }

      this.sql.exec(
        "UPDATE booking_requests SET status = 'accepted', answered_at = ? WHERE id = ?",
        now, request.id,
      );
      this.dropStaleRequests(original.id);
      this.logActivity("requestAccepted", actor.userId, [request.requester_user_id],
        `${actor.member.displayName} released ${studioName} for ` +
        `${formatTimeRange(request.start_ts, request.end_ts, timeZone)} to ${requesterName}.`);
      this.notify(request.requester_user_id, "requestAccepted",
        `${studioName} is yours`,
        `${actor.member.displayName} released ` +
        `${formatTimeRange(request.start_ts, request.end_ts, timeZone)} to you.`);
    });
    return true;
  }

  async cancelRequest(userId: string, requestId: string): Promise<void> {
    return this.guard(async () => {
      this.require(userId, "participate");
      const request = this.sql.exec<RequestRow>(
        "SELECT * FROM booking_requests WHERE id = ?", requestId,
      ).toArray()[0];
      if (!request || request.requester_user_id !== userId || request.status !== "pending") {
        fail("requestNoLongerAvailable");
      }
      this.sql.exec(
        "UPDATE booking_requests SET status = 'cancelled', answered_at = ? WHERE id = ?",
        this.now(), requestId,
      );
      if (request.day_request_id) this.settleDayRequest(request.day_request_id);
      this.broadcast();
    });
  }

  async createDayRequest(userId: string, draft: DayRequestDraft): Promise<DayRequest> {
    return this.guard(async () => {
      const caller = this.require(userId, "participate");
      const range = this.validatedRange(draft.startTs, draft.endTs);
      const note = sanitizedText(draft.note, TEXT_LIMITS.title);
      this.materializeStanding();

      const total = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM day_requests WHERE status = 'pending'",
      ).one().count;
      if (total >= LIMITS.maximumRequests) fail("dataLimitExceeded");

      const scope: DayRequestScope = draft.studioId === null ? "cascade" : "single";
      const candidates = draft.studioId === null
        ? this.orderedStudiosFor(userId)
        : [this.requireActiveStudio(draft.studioId)];

      const assessed = candidates.map((studio) => {
        const overlapping = this.bookingsOverlapping(studio.id, range.startTs, range.endTs);
        const mine = overlapping.filter((b) => b.owner_user_id === userId);
        const requestable = overlapping.filter(
          (b) => b.state === "reserved" && b.owner_user_id !== userId,
        );
        return {
          studio,
          free: overlapping.length === 0,
          requestable: overlapping.length > 0 && mine.length === 0 &&
            requestable.length === overlapping.length,
          bookings: requestable,
        };
      });

      const freeIndex = assessed.findIndex((entry) => entry.free);
      const preferredTargets = assessed
        .slice(0, freeIndex < 0 ? assessed.length : freeIndex)
        .filter((entry) => entry.requestable);

      const timeZone = this.teamRow().time_zone;
      const now = this.now();

      if (preferredTargets.length === 0) {
        if (freeIndex < 0) fail(scope === "single" ? "requestNotAllowed" : "noStudioAvailable");
        const studio = assessed[freeIndex]!.studio;
        const slots = slotsBetween(range.startTs, range.endTs);
        const bookingId = newId();
        const dayRequestId = newId();

        this.ctx.storage.transactionSync(() => {
          this.assertSlotsFree(studio.id, slots);
          this.insertBooking({
            id: bookingId, studioId: studio.id, ownerUserId: userId,
            startTs: range.startTs, endTs: range.endTs, title: note, state: "occupied",
            origin: "manual", standingRuleId: null, dayRequestId: null,
            createdAt: now, updatedAt: now,
          }, slots);
          this.sql.exec(
            `INSERT INTO day_requests (id, requester_user_id, start_ts, end_ts, scope, status,
               granted_studio_id, provisional_booking_id, note, created_at, answered_at)
             VALUES (?, ?, ?, ?, ?, 'fulfilled', ?, NULL, ?, ?, ?)`,
            dayRequestId, userId, range.startTs, range.endTs, scope, studio.id, note, now, now,
          );
          this.logActivity("bookingCreated", userId, [],
            `${caller.member.displayName} booked ${studio.name} for ` +
            `${formatTimeRange(range.startTs, range.endTs, timeZone)}.`);
        });

        this.broadcast();
        return this.toDayRequest(this.dayRequestRow(dayRequestId));
      }

      const fallback = freeIndex < 0 ? null : assessed[freeIndex]!.studio;
      const dayRequestId = newId();
      const provisionalId = fallback === null ? null : newId();

      const requestSeeds = await Promise.all(
        preferredTargets.flatMap((entry, rank) => entry.bookings.map(async (booking) => ({
          id: await this.stableId(`${dayRequestId}|${booking.id}|${userId}`),
          booking,
          rank,
          startTs: Math.max(range.startTs, booking.start_ts),
          endTs: Math.min(range.endTs, booking.end_ts),
        }))),
      );

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO day_requests (id, requester_user_id, start_ts, end_ts, scope, status,
             granted_studio_id, provisional_booking_id, note, created_at, answered_at)
           VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL)`,
          dayRequestId, userId, range.startTs, range.endTs, scope, provisionalId, note, now,
        );

        if (fallback !== null && provisionalId !== null) {
          const slots = slotsBetween(range.startTs, range.endTs);
          this.assertSlotsFree(fallback.id, slots);
          this.insertBooking({
            id: provisionalId, studioId: fallback.id, ownerUserId: userId,
            startTs: range.startTs, endTs: range.endTs, title: note, state: "reserved",
            origin: "provisional", standingRuleId: null, dayRequestId,
            createdAt: now, updatedAt: now,
          }, slots);
        }

        for (const seed of requestSeeds) {
          this.insertRequest(
            seed.id, seed.booking, userId, seed.startTs, seed.endTs, dayRequestId, seed.rank,
          );
          this.notifyRequestCreated(
            seed.booking, caller.member.displayName, seed.startTs, seed.endTs, timeZone,
          );
        }

        this.logActivity("requestCreated", userId, requestSeeds.map((s) => s.booking.owner_user_id),
          `${caller.member.displayName} requested ${formatDayTitle(range.startTs, timeZone)} ` +
          `${formatTimeRange(range.startTs, range.endTs, timeZone)}` +
          (fallback === null ? "." : ` and held ${fallback.name} in the meantime.`));
      });

      this.broadcast();
      return this.toDayRequest(this.dayRequestRow(dayRequestId));
    });
  }

  async cancelDayRequest(userId: string, dayRequestId: string): Promise<void> {
    return this.guard(async () => {
      this.require(userId, "participate");
      const row = this.dayRequestRow(dayRequestId);
      if (row.requester_user_id !== userId) fail("permissionDenied");
      if (row.status !== "pending") fail("requestNoLongerAvailable");

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "UPDATE booking_requests SET status = 'cancelled', answered_at = ? WHERE day_request_id = ? AND status = 'pending'",
          this.now(), dayRequestId,
        );
        if (row.provisional_booking_id) this.removeBooking(row.provisional_booking_id);
        this.sql.exec(
          "UPDATE day_requests SET status = 'cancelled', provisional_booking_id = NULL, answered_at = ? WHERE id = ?",
          this.now(), dayRequestId,
        );
      });

      this.broadcast();
    });
  }

  async updatePreferences(userId: string, patch: Partial<MemberPreferences>): Promise<MemberPreferences> {
    return this.guard(async () => {
      this.caller(userId);
      const current = this.preferencesOf(userId);

      const known = new Set(
        this.sql.exec<{ id: string }>("SELECT id FROM studios").toArray().map((r) => r.id),
      );
      const priority = Array.isArray(patch.studioPriority)
        ? Array.from(new Set(patch.studioPriority.filter((id) => typeof id === "string" && known.has(id))))
          .slice(0, LIMITS.maximumStudios)
        : current.studioPriority;

      const next: MemberPreferences = {
        notifyEnabled: typeof patch.notifyEnabled === "boolean" ? patch.notifyEnabled : current.notifyEnabled,
        notifyVibrate: typeof patch.notifyVibrate === "boolean" ? patch.notifyVibrate : current.notifyVibrate,
        studioPriority: priority,
      };

      this.sql.exec(
        `INSERT INTO member_prefs (user_id, notify_enabled, notify_vibrate, studio_priority)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           notify_enabled = excluded.notify_enabled,
           notify_vibrate = excluded.notify_vibrate,
           studio_priority = excluded.studio_priority`,
        userId, next.notifyEnabled ? 1 : 0, next.notifyVibrate ? 1 : 0,
        JSON.stringify(next.studioPriority),
      );
      return next;
    });
  }

  async savePushSubscription(userId: string, input: PushSubscriptionInput): Promise<void> {
    return this.guard(async () => {
      this.caller(userId);
      const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
      if (endpoint.length === 0 || endpoint.length > 2048 || !endpoint.startsWith("https://")) {
        fail("badRequest", "The push endpoint is invalid.");
      }
      if (!isBase64UrlOfLength(input.p256dh, 65) || !isBase64UrlOfLength(input.auth, 16)) {
        fail("badRequest", "The subscription keys are invalid.");
      }

      const id = await hashToken(this.keys.pepper, endpoint);
      const now = this.now();

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_id = excluded.user_id, p256dh = excluded.p256dh,
             auth = excluded.auth, created_at = excluded.created_at`,
          id, userId, endpoint, input.p256dh, input.auth, now,
        );
        this.sql.exec(
          `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
             SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
           )`,
          userId, userId, LIMITS.maximumPushSubscriptions,
        );
        this.ensurePreferences(userId);
      });
    });
  }

  async deletePushSubscription(userId: string, endpoint: string): Promise<void> {
    return this.guard(async () => {
      this.caller(userId);
      const id = await hashToken(this.keys.pepper, String(endpoint));
      this.sql.exec("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?", id, userId);
    });
  }

  async markNotificationsRead(userId: string): Promise<void> {
    return this.guard(async () => {
      this.caller(userId);
      this.sql.exec(
        "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
        this.now(), userId,
      );
    });
  }

  async sendTestNotification(userId: string): Promise<{ devices: number }> {
    return this.guard(async () => {
      const caller = this.caller(userId);
      const devices = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?", userId,
      ).one().count;
      this.notify(userId, "requestCreated", "Studio Raum",
        `Notifications are set up, ${caller.member.displayName}.`);
      this.flushPush();
      return { devices };
    });
  }

  async createStudio(userId: string, name: string, subtitle: string): Promise<Studio> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const cleanName = requiredText(name, TEXT_LIMITS.studioName);
      const cleanSubtitle = sanitizedText(subtitle, TEXT_LIMITS.subtitle);

      const count = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM studios").one().count;
      if (count >= LIMITS.maximumStudios) fail("dataLimitExceeded");

      const studio: Studio = {
        id: newId(), name: cleanName, subtitle: cleanSubtitle, sortOrder: count, isActive: true,
      };
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "INSERT INTO studios (id, name, subtitle, sort_order, is_active) VALUES (?, ?, ?, ?, 1)",
          studio.id, studio.name, studio.subtitle, studio.sortOrder,
        );
        this.logActivity("studioCreated", userId, [],
          `${caller.member.displayName} created ${studio.name}.`);
      });
      this.broadcast();
      return studio;
    });
  }

  async updateStudio(
    userId: string, studioId: string,
    patch: { name: string; subtitle: string; sortOrder: number; isActive: boolean },
  ): Promise<Studio> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const existing = this.sql.exec<StudioRow>(
        "SELECT * FROM studios WHERE id = ?", studioId,
      ).toArray()[0];
      if (!existing) fail("studioUnavailable");

      const cleanName = requiredText(patch.name, TEXT_LIMITS.studioName);
      const cleanSubtitle = sanitizedText(patch.subtitle, TEXT_LIMITS.subtitle);
      const sortOrder = Number.isInteger(patch.sortOrder) ? patch.sortOrder : existing.sort_order;

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "UPDATE studios SET name = ?, subtitle = ?, sort_order = ?, is_active = ? WHERE id = ?",
          cleanName, cleanSubtitle, sortOrder, patch.isActive ? 1 : 0, studioId,
        );
        this.logActivity("studioChanged", userId, [],
          `${caller.member.displayName} updated ${cleanName}.`);
      });
      this.broadcast();
      return {
        id: studioId, name: cleanName, subtitle: cleanSubtitle,
        sortOrder, isActive: patch.isActive,
      };
    });
  }

  async updateMember(
    userId: string, memberId: string,
    patch: { displayName: string; role: MemberRole; isActive: boolean; canWrite: boolean },
  ): Promise<void> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const existing = this.memberRowOrNull(memberId);
      if (!existing) fail("notFound");

      if (existing.role === "owner" || patch.role === "owner") fail("permissionDenied");
      if (patch.role !== "member" && patch.role !== "admin") fail("badRequest");

      const cleanName = requiredText(patch.displayName, TEXT_LIMITS.displayName, 2);
      const isPlaceholder = existing.is_placeholder === 1;
      const role = isPlaceholder ? "member" : patch.role;
      const canWrite = isPlaceholder ? false : patch.canWrite;

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE members SET display_name = ?, role = ?, is_active = ?, is_pending = 0, can_write = ?
           WHERE user_id = ?`,
          cleanName, role, patch.isActive ? 1 : 0, canWrite ? 1 : 0, memberId,
        );
        if (!patch.isActive) this.sql.exec("DELETE FROM sessions WHERE user_id = ?", memberId);
        this.logActivity("memberChanged", userId, [memberId],
          `${caller.member.displayName} updated ${cleanName}.`);
      });
      this.broadcast();
    });
  }

  async createPlaceholderMember(userId: string, displayName: string): Promise<TeamMember> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const cleanName = requiredText(displayName, TEXT_LIMITS.displayName, 2);

      const total = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM members",
      ).one().count;
      if (total >= LIMITS.joinableMembers) fail("dataLimitExceeded");

      const placeholderId = newId();
      const now = this.now();

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO members (user_id, display_name, role, is_active, is_pending,
                                can_write, created_at, secret_hash, is_placeholder)
           VALUES (?, ?, 'member', 1, 0, 0, ?, ?, 1)`,
          placeholderId, cleanName, now, `placeholder:${placeholderId}`,
        );
        this.ensurePreferences(placeholderId);
        this.logActivity("memberChanged", userId, [placeholderId],
          `${caller.member.displayName} added ${cleanName} as an external person.`);
      });

      this.broadcast();
      return this.toMember(this.memberRowOrNull(placeholderId)!);
    });
  }

  async deletePlaceholderMember(userId: string, memberId: string): Promise<void> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const existing = this.memberRowOrNull(memberId);
      if (!existing) fail("notFound");
      if (existing.is_placeholder !== 1) {
        fail("permissionDenied", "Only external people can be deleted.");
      }

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "UPDATE standing_marks SET booking_id = NULL WHERE booking_id IN (SELECT id FROM bookings WHERE owner_user_id = ?)",
          memberId,
        );
        this.sql.exec(
          "DELETE FROM booking_locks WHERE booking_id IN (SELECT id FROM bookings WHERE owner_user_id = ?)",
          memberId,
        );
        this.sql.exec("DELETE FROM bookings WHERE owner_user_id = ?", memberId);
        this.sql.exec(
          "UPDATE booking_requests SET status = 'cancelled', answered_at = ? WHERE booking_owner_user_id = ? AND status = 'pending'",
          this.now(), memberId,
        );
        this.sql.exec("DELETE FROM standing_rules WHERE member_user_id = ?", memberId);
        this.sql.exec("DELETE FROM member_prefs WHERE user_id = ?", memberId);
        this.sql.exec("DELETE FROM members WHERE user_id = ?", memberId);
        this.logActivity("memberChanged", userId, [memberId],
          `${caller.member.displayName} removed the external person ${existing.display_name}.`);
      });

      this.broadcast();
    });
  }

  async setMemberApproval(userId: string, memberId: string, approved: boolean): Promise<void> {
    return this.guard(async () => {
      const caller = this.require(userId, "manageTeam");
      const existing = this.memberRowOrNull(memberId);
      if (!existing || memberStatus(this.toMember(existing)) !== "pending") {
        fail("requestNoLongerAvailable");
      }

      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "UPDATE members SET is_active = ?, is_pending = 0, role = 'member' WHERE user_id = ?",
          approved ? 1 : 0, memberId,
        );
        if (!approved) this.sql.exec("DELETE FROM sessions WHERE user_id = ?", memberId);
        this.logActivity("memberChanged", userId, [memberId],
          approved
            ? `${caller.member.displayName} approved ${existing.display_name} for the team.`
            : `${caller.member.displayName} declined the join request from ${existing.display_name}.`);
      });
      this.broadcast();
    });
  }

  async updateTeam(
    userId: string,
    patch: { name: string; timeZone: string; joinMode: JoinMode },
  ): Promise<void> {
    return this.guard(async () => {
      this.require(userId, "manageTeam");
      const cleanName = requiredText(patch.name, TEXT_LIMITS.teamName, 2);
      if (!isValidTimeZone(patch.timeZone)) fail("badRequest", "Unknown time zone.");
      if (!["closed", "view", "approval"].includes(patch.joinMode)) fail("badRequest");

      this.sql.exec(
        "UPDATE team SET name = ?, time_zone = ?, join_mode = ?",
        cleanName, patch.timeZone, patch.joinMode,
      );
      this.broadcast();
    });
  }

  async rotateJoinSecret(userId: string): Promise<{ joinSecret: string }> {
    return this.guard(async () => {
      this.require(userId, "manageTeam");
      const team = this.teamRow();
      const joinSecret = newJoinSecret(team.team_ref);
      const hash = await this.hash(joinSecret);
      this.sql.exec(
        "UPDATE team SET join_secret_hash = ?, join_secret_rotated_at = ?",
        hash, this.now(),
      );
      return { joinSecret };
    });
  }

  async rotatePersonalSecret(userId: string): Promise<{ personalSecret: string; sessionToken: string }> {
    return this.guard(async () => {
      this.caller(userId);
      const team = this.teamRow();
      const personalSecret = newPersonalSecret(team.team_ref);
      const sessionToken = newSessionToken();
      const [secretHash, tokenHash] = await Promise.all([
        this.hash(personalSecret),
        hashToken(this.keys.pepper, sessionToken),
      ]);
      const now = this.now();

      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE members SET secret_hash = ? WHERE user_id = ?", secretHash, userId);
        this.sql.exec("DELETE FROM sessions WHERE user_id = ?", userId);
        this.insertSession(tokenHash, userId, now);
      });
      return { personalSecret, sessionToken };
    });
  }

  async deleteMyData(userId: string): Promise<{ teamDeleted: boolean }> {
    return this.guard(async () => {
      const caller = this.caller(userId);

      if (caller.member.role === "owner") {
        this.broadcast("deleted");
        await this.ctx.storage.deleteAll();
        migrate(this.sql);
        for (const socket of this.ctx.getWebSockets()) {
          try {
            socket.close(1000, "Team deleted");
          } catch {
          }
        }
        return { teamDeleted: true };
      }

      const displayName = caller.member.displayName;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "UPDATE standing_marks SET booking_id = NULL WHERE booking_id IN (SELECT id FROM bookings WHERE owner_user_id = ?)",
          userId,
        );
        this.sql.exec(
          "DELETE FROM booking_locks WHERE booking_id IN (SELECT id FROM bookings WHERE owner_user_id = ?)",
          userId,
        );
        this.sql.exec("DELETE FROM bookings WHERE owner_user_id = ?", userId);
        this.sql.exec(
          "DELETE FROM booking_requests WHERE requester_user_id = ? OR booking_owner_user_id = ?",
          userId, userId,
        );
        this.sql.exec("DELETE FROM day_requests WHERE requester_user_id = ?", userId);
        this.sql.exec("DELETE FROM standing_rules WHERE member_user_id = ?", userId);
        this.sql.exec("DELETE FROM member_prefs WHERE user_id = ?", userId);
        this.sql.exec("DELETE FROM push_subscriptions WHERE user_id = ?", userId);
        this.sql.exec("DELETE FROM notifications WHERE user_id = ?", userId);
        this.sql.exec(
          "DELETE FROM activities WHERE actor_user_id = ? OR related_user_ids LIKE ?",
          userId, `%"${userId}"%`,
        );
        if (displayName.length > 0) {
          this.sql.exec(
            "UPDATE activities SET message = REPLACE(message, ?, 'Deleted member') WHERE message LIKE ?",
            displayName, `%${displayName}%`,
          );
        }
        this.sql.exec("DELETE FROM sessions WHERE user_id = ?", userId);
        this.sql.exec("DELETE FROM members WHERE user_id = ?", userId);
      });

      this.broadcast();
      return { teamDeleted: false };
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("A WebSocket connection is expected.", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]!);
    return new Response(null, { status: 101, webSocket: pair[0]! });
  }

  override async webSocketMessage(ws: WebSocket): Promise<void> {
    ws.send(JSON.stringify({ type: "pong" }));
  }

  private broadcast(type: "changed" | "deleted" = "changed"): void {
    const payload = JSON.stringify({ type });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
      }
    }
    this.flushPush();
  }

  private materializeStanding(force = false): number {
    const team = this.teamRowOrNull();
    if (team === null) return 0;

    const zone = team.time_zone;
    const now = this.now();
    const today = startOfDay(now, zone);
    const horizon = addDays(today, STANDING_HORIZON_DAYS, zone);
    const through = Number(this.metaValue("materialized_through") ?? "0");
    if (!force && through >= horizon) return 0;

    const rules = this.sql.exec<StandingRuleRow>(
      "SELECT * FROM standing_rules WHERE is_active = 1",
    ).toArray();

    if (rules.length === 0) {
      this.setMeta("materialized_through", String(horizon));
      return 0;
    }

    const days: Array<{ start: number; end: number; weekday: number }> = [];
    let cursor = today;
    for (let index = 0; index <= STANDING_HORIZON_DAYS; index++) {
      const next = addDays(cursor, 1, zone);
      days.push({ start: cursor, end: next, weekday: weekdayOf(cursor, zone) });
      cursor = next;
    }

    let created = 0;
    this.ctx.storage.transactionSync(() => {
      for (const rule of rules) {
        const member = this.memberRowOrNull(rule.member_user_id);
        const mayHold = member !== null &&
          member.is_active === 1 &&
          (member.can_write === 1 || member.is_placeholder === 1);
        if (!mayHold) continue;
        const studio = this.sql.exec<StudioRow>(
          "SELECT * FROM studios WHERE id = ? AND is_active = 1", rule.studio_id,
        ).toArray()[0];
        if (!studio) continue;

        for (const day of days) {
          if (day.weekday !== rule.weekday) continue;
          const marked = this.sql.exec<{ rule_id: string }>(
            "SELECT rule_id FROM standing_marks WHERE rule_id = ? AND day_ts = ?",
            rule.id, day.start,
          ).toArray()[0];
          if (marked) continue;

          const bookingId = this.writeStandingBooking(rule, day, zone, now);
          this.sql.exec(
            "INSERT INTO standing_marks (rule_id, day_ts, booking_id) VALUES (?, ?, ?)",
            rule.id, day.start, bookingId,
          );
          if (bookingId !== null) created++;
        }
      }

      this.sql.exec("DELETE FROM standing_marks WHERE day_ts < ?", addDays(today, -120, zone));
      this.setMeta("materialized_through", String(horizon));
    });

    return created;
  }

  private writeStandingBooking(
    rule: StandingRuleRow,
    day: { start: number; end: number },
    zone: string,
    now: number,
  ): string | null {
    const parts = zonedParts(day.start, zone);
    const at = (minute: number) => zonedTimestamp(
      parts.year, parts.month, parts.day,
      Math.floor(minute / 60), minute % 60, 0, zone,
    );

    const start = roundedDownToSlot(at(rule.start_minute));
    const rawEnd = rule.end_minute >= 1440 ? day.end : at(rule.end_minute);
    const end = roundedDownToSlot(Math.min(rawEnd, start + MAXIMUM_DURATION));

    if (!(start < end) || end <= now) return null;

    let slots: number[];
    try {
      slots = slotsBetween(start, end);
    } catch {
      return null;
    }

    for (const slot of slots) {
      const taken = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM booking_locks WHERE studio_id = ? AND slot_ts = ?",
        rule.studio_id, slot,
      ).one().count;
      if (taken > 0) return null;
    }

    const id = newId();
    this.insertBooking({
      id, studioId: rule.studio_id, ownerUserId: rule.member_user_id,
      startTs: start, endTs: end, title: rule.title, state: rule.state,
      origin: "standing", standingRuleId: rule.id, dayRequestId: null,
      createdAt: now, updatedAt: now,
    }, slots);
    return id;
  }

  private clearFutureStanding(ruleId: string): void {
    const now = this.now();
    const future = this.sql.exec<{ id: string }>(
      "SELECT id FROM bookings WHERE standing_rule_id = ? AND start_ts > ?", ruleId, now,
    ).toArray();
    for (const row of future) this.removeBooking(row.id);
    this.sql.exec("DELETE FROM standing_marks WHERE rule_id = ? AND day_ts >= ?", ruleId, startOfDay(now, this.teamRow().time_zone));
    this.setMeta("materialized_through", "0");
  }

  private settleDayRequest(dayRequestId: string): void {
    const row = this.sql.exec<DayRequestRow>(
      "SELECT * FROM day_requests WHERE id = ?", dayRequestId,
    ).toArray()[0];
    if (!row || row.status !== "pending") return;

    const requests = this.sql.exec<RequestRow>(
      "SELECT * FROM booking_requests WHERE day_request_id = ?", dayRequestId,
    ).toArray();
    const pending = requests.filter((r) => r.status === "pending");

    const ranked = new Map<string, number>();
    for (const request of requests) {
      const known = ranked.get(request.studio_id);
      if (known === undefined || request.priority < known) ranked.set(request.studio_id, request.priority);
    }

    const won = [...ranked.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([studioId]) => studioId)
      .find((studioId) => this.ownsWindow(row.requester_user_id, studioId, row.start_ts, row.end_ts));

    const now = this.now();
    const timeZone = this.teamRow().time_zone;

    if (won !== undefined) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "UPDATE booking_requests SET status = 'cancelled', answered_at = ? WHERE day_request_id = ? AND status = 'pending'",
          now, dayRequestId,
        );
        if (row.provisional_booking_id) this.removeBooking(row.provisional_booking_id);
        this.sql.exec(
          `UPDATE day_requests SET status = 'fulfilled', granted_studio_id = ?,
             provisional_booking_id = NULL, answered_at = ? WHERE id = ?`,
          won, now, dayRequestId,
        );
        this.notify(row.requester_user_id, "dayRequestFulfilled",
          `${this.studioName(won)} is yours`,
          `You are in ${this.studioName(won)} on ${formatDayTitle(row.start_ts, timeZone)}, ` +
          `${formatTimeRange(row.start_ts, row.end_ts, timeZone)}.`);
      });
      return;
    }

    if (pending.length > 0) return;

    this.ctx.storage.transactionSync(() => {
      if (row.provisional_booking_id !== null) {
        const fallback = this.sql.exec<BookingRow>(
          "SELECT * FROM bookings WHERE id = ?", row.provisional_booking_id,
        ).toArray()[0];
        if (fallback) {
          this.sql.exec(
            "UPDATE bookings SET state = 'occupied', origin = 'manual', updated_at = ? WHERE id = ?",
            now, fallback.id,
          );
          this.sql.exec(
            `UPDATE day_requests SET status = 'fulfilled', granted_studio_id = ?,
               provisional_booking_id = NULL, answered_at = ? WHERE id = ?`,
            fallback.studio_id, now, dayRequestId,
          );
          this.notify(row.requester_user_id, "dayRequestFulfilled",
            `${this.studioName(fallback.studio_id)} stays yours`,
            "Nobody released their room. Your hold is now " +
            `a firm booking on ${formatDayTitle(row.start_ts, timeZone)}.`);
          return;
        }
      }
      this.sql.exec(
        "UPDATE day_requests SET status = 'declined', provisional_booking_id = NULL, answered_at = ? WHERE id = ?",
        now, dayRequestId,
      );
      this.notify(row.requester_user_id, "dayRequestDeclined",
        "No room released",
        `Nobody released their room for ${formatDayTitle(row.start_ts, timeZone)}.`);
    });
  }

  private ownsWindow(userId: string, studioId: string, startTs: number, endTs: number): boolean {
    const owned = this.bookingsOverlapping(studioId, startTs, endTs)
      .filter((b) => b.owner_user_id === userId)
      .map((b) => ({ start: b.start_ts, end: b.end_ts }));
    return gapsIn(owned, { start: startTs, end: endTs }).length === 0;
  }

  private affectedDayRequests(bookingId: string, ownDayRequestId: string | null): string[] {
    const ids = new Set<string>();
    if (ownDayRequestId) ids.add(ownDayRequestId);
    for (const row of this.sql.exec<{ day_request_id: string | null }>(
      "SELECT DISTINCT day_request_id FROM booking_requests WHERE booking_id = ? AND day_request_id IS NOT NULL",
      bookingId,
    ).toArray()) {
      if (row.day_request_id) ids.add(row.day_request_id);
    }
    return [...ids];
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private hash(secret: string): Promise<string> {
    return hashSecret(this.keys.pepper, secret);
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StudioRaumError) throw encodeErrorForRpc(error);
      if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
        throw encodeErrorForRpc(new StudioRaumError("bookingConflict"));
      }
      throw error;
    }
  }

  private metaValue(key: string): string | null {
    return this.sql.exec<{ value: string }>(
      "SELECT value FROM meta WHERE key = ?", key,
    ).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value,
    );
  }

  private teamRowOrNull(): TeamRow | null {
    return this.sql.exec<TeamRow>("SELECT * FROM team LIMIT 1").toArray()[0] ?? null;
  }

  private teamRow(): TeamRow {
    const row = this.teamRowOrNull();
    if (!row) fail("noTeam");
    return row;
  }

  private memberRowOrNull(userId: string): MemberRow | null {
    return this.sql.exec<MemberRow>(
      `SELECT user_id, display_name, role, is_active, is_pending, can_write, created_at,
              is_placeholder FROM members WHERE user_id = ?`,
      userId,
    ).toArray()[0] ?? null;
  }

  private caller(userId: string): Caller {
    const row = this.memberRowOrNull(userId);
    if (!row) fail("permissionDenied");
    return { userId, member: this.toMember(row), canWrite: row.can_write === 1 };
  }

  private require(userId: string, permission: Permission): Caller {
    const caller = this.caller(userId);
    if (!caller.canWrite) fail("readOnly");
    if (!caller.member.isActive) {
      fail(memberStatus(caller.member) === "pending" ? "memberPending" : "memberDisabled");
    }
    if (!allows(caller.member, permission)) fail("permissionDenied");
    return caller;
  }

  private validatedRange(startTs: unknown, endTs: unknown): { startTs: number; endTs: number } {
    if (typeof startTs !== "number" || typeof endTs !== "number") fail("invalidTime");
    validateRange(startTs, endTs);
    return { startTs, endTs };
  }

  private validatedState(value: unknown, fallbackState: BookingState): BookingState {
    if (value === "reserved" || value === "occupied") return value;
    if (value === undefined || value === null) return fallbackState;
    fail("badRequest", "Unknown booking state.");
  }

  private validatedRule(draft: StandingRuleDraft, ignoreRuleId: string | null): StandingRuleDraft {
    const studio = this.requireActiveStudio(draft.studioId);
    const member = this.memberRowOrNull(String(draft.memberUserId ?? ""));
    if (!member || member.is_active !== 1) {
      fail("badRequest", "This person is not active in the team.");
    }
    const weekday = Number(draft.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) fail("badRequest", "Unknown weekday.");

    const startMinute = Number(draft.startMinute);
    const endMinute = Number(draft.endMinute);
    if (
      !Number.isInteger(startMinute) || !Number.isInteger(endMinute) ||
      startMinute < 0 || startMinute >= 1440 || endMinute <= startMinute || endMinute > 1440 ||
      startMinute % 30 !== 0 || endMinute % 30 !== 0
    ) {
      fail("invalidTime");
    }

    const siblings = this.sql.exec<StandingRuleRow>(
      "SELECT * FROM standing_rules WHERE studio_id = ? AND weekday = ? AND is_active = 1",
      studio.id, weekday,
    ).toArray();
    for (const other of siblings) {
      if (other.id === ignoreRuleId) continue;
      if (startMinute < other.end_minute && endMinute > other.start_minute) fail("standingConflict");
    }

    return {
      studioId: studio.id,
      weekday,
      memberUserId: member.user_id,
      startMinute,
      endMinute,
      state: this.validatedState(draft.state, "reserved"),
      title: sanitizedText(draft.title, TEXT_LIMITS.title),
      isActive: draft.isActive !== false,
    };
  }

  private validatedDays(dayStarts: unknown): number[] {
    if (!Array.isArray(dayStarts) || dayStarts.length === 0) {
      fail("badRequest", "No day is selected.");
    }
    if (dayStarts.length > LIMITS.maximumReleaseDays) {
      fail("badRequest", `At most ${LIMITS.maximumReleaseDays} days at once.`);
    }

    const timeZone = this.teamRow().time_zone;
    const unique = new Set<number>();
    for (const value of dayStarts) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds)) fail("badRequest", "Unknown day.");
      unique.add(startOfDay(Math.floor(seconds), timeZone));
    }
    return [...unique].sort((a, b) => a - b);
  }

  private requireActiveStudio(studioId: unknown): Studio {
    if (typeof studioId !== "string") fail("studioUnavailable");
    const row = this.sql.exec<StudioRow>("SELECT * FROM studios WHERE id = ?", studioId).toArray()[0];
    if (!row || row.is_active !== 1) fail("studioUnavailable");
    return this.toStudio(row);
  }

  private bookingRow(bookingId: unknown): BookingRow {
    if (typeof bookingId !== "string") fail("notFound");
    const row = this.sql.exec<BookingRow>("SELECT * FROM bookings WHERE id = ?", bookingId).toArray()[0];
    if (!row) fail("notFound");
    return row;
  }

  private standingRuleRow(ruleId: unknown): StandingRuleRow {
    if (typeof ruleId !== "string") fail("notFound");
    const row = this.sql.exec<StandingRuleRow>(
      "SELECT * FROM standing_rules WHERE id = ?", ruleId,
    ).toArray()[0];
    if (!row) fail("notFound");
    return row;
  }

  private dayRequestRow(id: unknown): DayRequestRow {
    if (typeof id !== "string") fail("notFound");
    const row = this.sql.exec<DayRequestRow>("SELECT * FROM day_requests WHERE id = ?", id).toArray()[0];
    if (!row) fail("notFound");
    return row;
  }

  private bookingsOverlapping(studioId: string, startTs: number, endTs: number): BookingRow[] {
    return this.sql.exec<BookingRow>(
      "SELECT * FROM bookings WHERE studio_id = ? AND start_ts < ? AND end_ts > ? ORDER BY start_ts",
      studioId, endTs, startTs,
    ).toArray();
  }

  private orderedStudiosFor(userId: string): Studio[] {
    const priority = this.preferencesOf(userId).studioPriority;
    const rank = new Map(priority.map((id, index) => [id, index]));
    return this.sql.exec<StudioRow>("SELECT * FROM studios WHERE is_active = 1").toArray()
      .map((row) => this.toStudio(row))
      .sort((a, b) => {
        const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "en");
      });
  }

  private assertSlotsFree(studioId: string, slots: number[]): void {
    for (const slot of slots) {
      const taken = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM booking_locks WHERE studio_id = ? AND slot_ts = ?",
        studioId, slot,
      ).one().count;
      if (taken > 0) fail("bookingConflict");
    }
  }

  private insertLocks(studioId: string, slots: number[], bookingId: string, ownerUserId: string): void {
    for (const slot of slots) {
      this.sql.exec(
        "INSERT INTO booking_locks (studio_id, slot_ts, booking_id, owner_user_id) VALUES (?, ?, ?, ?)",
        studioId, slot, bookingId, ownerUserId,
      );
    }
  }

  private insertBooking(booking: Booking, slots: number[]): void {
    this.sql.exec(
      `INSERT INTO bookings (id, studio_id, owner_user_id, start_ts, end_ts, title,
                             state, origin, standing_rule_id, day_request_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      booking.id, booking.studioId, booking.ownerUserId, booking.startTs, booking.endTs,
      booking.title, booking.state, booking.origin, booking.standingRuleId, booking.dayRequestId,
      booking.createdAt, booking.updatedAt,
    );
    this.insertLocks(booking.studioId, slots, booking.id, booking.ownerUserId);
  }

  private removeBooking(bookingId: string): void {
    this.sql.exec("UPDATE standing_marks SET booking_id = NULL WHERE booking_id = ?", bookingId);
    this.sql.exec(
      "UPDATE day_requests SET provisional_booking_id = NULL WHERE provisional_booking_id = ?", bookingId,
    );
    this.sql.exec("DELETE FROM booking_locks WHERE booking_id = ?", bookingId);
    this.sql.exec("DELETE FROM bookings WHERE id = ?", bookingId);
  }

  private insertRequest(
    id: string, booking: BookingRow, requesterUserId: string,
    startTs: number, endTs: number, dayRequestId: string | null, priority: number,
  ): void {
    this.sql.exec(
      `INSERT INTO booking_requests
         (id, booking_id, studio_id, booking_owner_user_id, requester_user_id,
          start_ts, end_ts, status, created_at, answered_at, day_request_id, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         booking_owner_user_id = excluded.booking_owner_user_id,
         start_ts = excluded.start_ts, end_ts = excluded.end_ts,
         status = 'pending', created_at = excluded.created_at, answered_at = NULL,
         day_request_id = excluded.day_request_id, priority = excluded.priority`,
      id, booking.id, booking.studio_id, booking.owner_user_id, requesterUserId,
      startTs, endTs, this.now(), dayRequestId, priority,
    );
  }

  private dropStaleRequests(bookingId: string): void {
    this.sql.exec(
      `UPDATE booking_requests SET status = 'cancelled', answered_at = ?
       WHERE booking_id = ? AND status = 'pending' AND NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.id = booking_requests.booking_id
           AND booking_requests.start_ts >= b.start_ts
           AND booking_requests.end_ts <= b.end_ts
       )`,
      this.now(), bookingId,
    );
  }

  private declinePendingRequestsFor(bookingId: string, actorUserId: string): void {
    this.sql.exec(
      `UPDATE booking_requests SET status = 'declined', answered_at = ?
       WHERE booking_id = ? AND status = 'pending' AND requester_user_id <> ?`,
      this.now(), bookingId, actorUserId,
    );
  }

  private insertSession(tokenHash: string, userId: string, now: number): void {
    this.sql.exec(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      tokenHash, userId, now, now, now + SESSION_IDLE_SECONDS,
    );
  }

  private pruneSessions(now: number): void {
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ? OR created_at + ? <= ?",
      now, SESSION_ABSOLUTE_SECONDS, now);
  }

  private logActivity(
    kind: ActivityKind, actorUserId: string, relatedUserIds: string[], message: string,
  ): void {
    const related = Array.from(new Set(relatedUserIds.filter((id) => id && id !== actorUserId))).sort();
    this.sql.exec(
      "INSERT INTO activities (id, kind, actor_user_id, related_user_ids, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      newId(), kind, actorUserId, JSON.stringify(related),
      sanitizedText(message, TEXT_LIMITS.message), this.now(),
    );
    this.sql.exec(
      `DELETE FROM activities WHERE id NOT IN (
         SELECT id FROM activities ORDER BY created_at DESC, id DESC LIMIT ?
       )`,
      LIMITS.visibleActivities,
    );
  }

  private studioName(studioId: string): string {
    return this.sql.exec<{ name: string }>(
      "SELECT name FROM studios WHERE id = ?", studioId,
    ).toArray()[0]?.name ?? "Studio";
  }

  private memberName(userId: string): string {
    return this.memberRowOrNull(userId)?.display_name ?? "Member";
  }

  private async stableId(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  private ensurePreferences(userId: string): void {
    this.sql.exec(
      "INSERT INTO member_prefs (user_id, notify_enabled, notify_vibrate, studio_priority) VALUES (?, 1, 1, '[]') ON CONFLICT(user_id) DO NOTHING",
      userId,
    );
  }

  private preferencesOf(userId: string): MemberPreferences {
    const row = this.sql.exec<{ notify_enabled: number; notify_vibrate: number; studio_priority: string }>(
      "SELECT notify_enabled, notify_vibrate, studio_priority FROM member_prefs WHERE user_id = ?",
      userId,
    ).toArray()[0];
    if (!row) return { ...DEFAULT_PREFERENCES, studioPriority: [] };

    let priority: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.studio_priority);
      if (Array.isArray(parsed)) priority = parsed.filter((id): id is string => typeof id === "string");
    } catch {
    }
    return {
      notifyEnabled: row.notify_enabled === 1,
      notifyVibrate: row.notify_vibrate === 1,
      studioPriority: priority,
    };
  }

  private notify(userId: string, kind: NotificationKind, title: string, body: string): void {
    const cleanTitle = sanitizedText(title, 120);
    const cleanBody = sanitizedText(body, TEXT_LIMITS.message);
    this.sql.exec(
      "INSERT INTO notifications (id, user_id, kind, title, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      newId(), userId, kind, cleanTitle, cleanBody, this.now(),
    );
    this.sql.exec(
      `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
         SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
       )`,
      userId, userId, LIMITS.visibleNotifications,
    );
    this.pendingPush.push({
      userId,
      payload: { title: cleanTitle, body: cleanBody, tag: kind, vibrate: true },
    });
  }

  private notifyRequestCreated(
    booking: BookingRow, requesterName: string, startTs: number, endTs: number, timeZone: string,
  ): void {
    this.notify(booking.owner_user_id, "requestCreated",
      `${requesterName} requests ${this.studioName(booking.studio_id)}`,
      `${formatDayTitle(startTs, timeZone)}, ${formatTimeRange(startTs, endTs, timeZone)}. ` +
      "You can release it or keep the time range.");
  }

  private flushPush(): void {
    const queue = this.pendingPush;
    this.pendingPush = [];
    if (queue.length === 0) return;

    const config = this.keys.vapid;
    if (config === null) return;

    const targets = queue.map((item) => {
      const prefs = this.preferencesOf(item.userId);
      if (!prefs.notifyEnabled) return null;
      const subscriptions = this.sql.exec<PushRow>(
        "SELECT * FROM push_subscriptions WHERE user_id = ?", item.userId,
      ).toArray();
      return { subscriptions, payload: { ...item.payload, vibrate: prefs.notifyVibrate } };
    }).filter((item): item is { subscriptions: PushRow[]; payload: PushPayload } => item !== null);

    if (targets.length === 0) return;

    this.ctx.waitUntil((async () => {
      for (const target of targets) {
        for (const subscription of target.subscriptions) {
          try {
            const result = await sendPush(config, subscription, target.payload);
            if (result.gone) {
              this.sql.exec("DELETE FROM push_subscriptions WHERE id = ?", subscription.id);
            }
          } catch {
          }
        }
      }
    })());
  }

  private buildSnapshot(caller: Caller): TeamSnapshot {
    const team = this.teamRow();
    const isManager = allows(caller.member, "manageTeam");
    const historySince = this.now() - DAY_REQUEST_HISTORY_SECONDS;

    return {
      team: {
        id: team.id, name: team.name, timeZone: team.time_zone,
        createdAt: team.created_at, joinMode: team.join_mode,
      } satisfies StudioTeam,
      members: this.sql.exec<MemberRow>(
        `SELECT user_id, display_name, role, is_active, is_pending, can_write, created_at,
                is_placeholder FROM members`,
      ).toArray().map((row) => this.toMember(row)),
      studios: this.sql.exec<StudioRow>("SELECT * FROM studios").toArray().map((r) => this.toStudio(r)),
      bookings: this.sql.exec<BookingRow>("SELECT * FROM bookings").toArray().map((r) => this.toBooking(r)),
      requests: this.sql.exec<RequestRow>("SELECT * FROM booking_requests WHERE status = 'pending'")
        .toArray().map((r) => this.toRequest(r)),
      dayRequests: this.sql.exec<DayRequestRow>(
        `SELECT * FROM day_requests
         WHERE status = 'pending' OR (requester_user_id = ? AND created_at >= ?)
         ORDER BY created_at DESC`,
        caller.userId, historySince,
      ).toArray().map((r) => this.toDayRequest(r)),
      standingRules: this.sql.exec<StandingRuleRow>(
        "SELECT * FROM standing_rules ORDER BY weekday, start_minute",
      ).toArray().map((r) => this.toStandingRule(r)),
      notifications: this.sql.exec<NotificationRow>(
        "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        caller.userId, LIMITS.visibleNotifications,
      ).toArray().map((r) => ({
        id: r.id, kind: r.kind, title: r.title, body: r.body,
        createdAt: r.created_at, readAt: r.read_at,
      } satisfies AppNotification)),
      preferences: this.preferencesOf(caller.userId),
      activities: isManager
        ? this.sql.exec<{
            id: string; kind: ActivityKind; actor_user_id: string; message: string; created_at: number;
          }>(
            "SELECT id, kind, actor_user_id, message, created_at FROM activities ORDER BY created_at DESC LIMIT ?",
            LIMITS.visibleActivities,
          ).toArray().map((row) => ({
            id: row.id, kind: row.kind, actorUserId: row.actor_user_id,
            message: row.message, createdAt: row.created_at,
          }))
        : [],
      currentUserId: caller.userId,
      role: caller.member.role,
      canWrite: caller.canWrite,
      pushPublicKey: this.keys.vapid?.publicKey ?? "",
      fetchedAt: this.now(),
    };
  }

  private toMember(row: MemberRow): TeamMember {
    return {
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active === 1,
      isPending: row.is_active === 1 ? false : row.is_pending === 1,
      isPlaceholder: row.is_placeholder === 1,
      createdAt: row.created_at,
    };
  }

  private toStudio(row: StudioRow): Studio {
    return {
      id: row.id, name: row.name, subtitle: row.subtitle,
      sortOrder: row.sort_order, isActive: row.is_active === 1,
    };
  }

  private toBooking(row: BookingRow): Booking {
    return {
      id: row.id, studioId: row.studio_id, ownerUserId: row.owner_user_id,
      startTs: row.start_ts, endTs: row.end_ts, title: row.title,
      state: row.state, origin: row.origin,
      standingRuleId: row.standing_rule_id, dayRequestId: row.day_request_id,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private toRequest(row: RequestRow): BookingRequest {
    return {
      id: row.id, bookingId: row.booking_id, studioId: row.studio_id,
      bookingOwnerUserId: row.booking_owner_user_id, requesterUserId: row.requester_user_id,
      startTs: row.start_ts, endTs: row.end_ts, status: row.status,
      dayRequestId: row.day_request_id,
      createdAt: row.created_at, answeredAt: row.answered_at,
    };
  }

  private toStandingRule(row: StandingRuleRow): StandingRule {
    return {
      id: row.id, studioId: row.studio_id, weekday: row.weekday,
      memberUserId: row.member_user_id, startMinute: row.start_minute,
      endMinute: row.end_minute, state: row.state, title: row.title,
      isActive: row.is_active === 1, createdAt: row.created_at,
    };
  }

  private toDayRequest(row: DayRequestRow): DayRequest {
    return {
      id: row.id, requesterUserId: row.requester_user_id,
      startTs: row.start_ts, endTs: row.end_ts, scope: row.scope, status: row.status,
      grantedStudioId: row.granted_studio_id, provisionalBookingId: row.provisional_booking_id,
      note: row.note, createdAt: row.created_at, answeredAt: row.answered_at,
    };
  }

  private enforceRateLimit(bucket: string): void {
    const now = this.now();
    const row = this.sql.exec<{ count: number; window_start: number }>(
      "SELECT count, window_start FROM rate_limits WHERE bucket = ?", bucket,
    ).toArray()[0];
    if (!row) return;
    if (now - row.window_start >= RATE_WINDOW_SECONDS) {
      this.sql.exec("DELETE FROM rate_limits WHERE bucket = ?", bucket);
      return;
    }
    if (row.count >= RATE_MAX_ATTEMPTS) fail("rateLimited");
  }

  private recordFailedAttempt(bucket: string): void {
    const now = this.now();
    this.sql.exec(
      `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN ? - rate_limits.window_start >= ? THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN ? - rate_limits.window_start >= ? THEN ? ELSE rate_limits.window_start END`,
      bucket, now, now, RATE_WINDOW_SECONDS, now, RATE_WINDOW_SECONDS, now,
    );
  }

  private clearRateLimit(bucket: string): void {
    this.sql.exec("DELETE FROM rate_limits WHERE bucket = ?", bucket);
  }
}
