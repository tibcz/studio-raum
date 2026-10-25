import type { AppNotification, Booking, BookingRequest, DayRequest } from "../../domain/models";
import { formatDayTitle, formatTime, formatTimeRange } from "../../domain/format";
import { zonedParts } from "../../domain/time";
import { el, icon } from "../dom";
import { api } from "../api";
import { emptyState, run, toast } from "../ui";
import * as store from "../state";
import { openBookingDetail } from "./booking-sheets";

type Refresh = () => Promise<void>;

const DAY_REQUEST_STATUS: Record<DayRequest["status"], string> = {
  pending: "Open",
  fulfilled: "Granted",
  declined: "No luck",
  cancelled: "Withdrawn",
};

export function myBookingsView(refresh: Refresh): HTMLElement {
  const screen = el("div", { class: "screen stack" });
  const mine = store.myUpcomingBookings();
  const incoming = store.incomingRequests();
  const outgoing = store.outgoingRequests();
  const dayRequests = store.myDayRequests();
  const news = store.notifications();

  screen.append(el("h1", { text: "My bookings" }));

  if (incoming.length > 0) {
    screen.append(
      el("div", { class: "section-title", text: "Requests to you" }),
      el("div", { class: "stack" }, ...incoming.map((request) => incomingCard(request, refresh))),
    );
  }

  screen.append(
    el("div", { class: "section-title", text: "My next bookings" }),
    mine.length === 0
      ? el("div", { class: "card" }, emptyState("No upcoming bookings"))
      : el("div", { class: "card list" }, ...mine.map((item) => bookingRow(item, refresh))),
  );

  if (dayRequests.length > 0) {
    screen.append(
      el("div", { class: "section-title", text: "My day requests" }),
      el("div", { class: "stack" }, ...dayRequests.map((request) => dayRequestCard(request, refresh))),
    );
  }

  if (outgoing.length > 0) {
    screen.append(
      el("div", { class: "section-title", text: "My single requests" }),
      el("div", { class: "stack" }, ...outgoing.map((request) => outgoingRow(request, refresh))),
    );
  }

  if (news.length > 0) {
    screen.append(
      el("div", { class: "row-between" },
        el("div", { class: "section-title", text: "Notifications" }),
        store.unreadNotifications().length === 0
          ? null
          : el("button", {
              class: "btn btn-quiet",
              onClick: async () => { await run(() => api.markNotificationsRead()); await refresh(); },
            }, el("span", { text: "Mark all read" }))),
      el("div", { class: "card list" }, ...news.slice(0, 20).map(notificationRow)),
    );
  }

  return screen;
}

function bookingRow(item: Booking, refresh: Refresh): HTMLElement {
  const zone = store.timeZone();
  const parts = zonedParts(item.startTs, zone);
  const month = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: zone })
    .format(new Date(item.startTs * 1000));

  return el("button", {
    class: "list-item",
    onClick: () => openBookingDetail(item, refresh),
  },
    el("div", { class: "datebox" },
      el("div", { class: "d", text: parts.day }),
      el("div", { class: "tiny dim", text: month })),
    el("div", { class: `booking-bar bar-${item.state}` }),
    el("div", { class: "grow" },
      el("div", { text: store.studioName(item.studioId) }),
      el("div", { class: "small dim num", text: formatTimeRange(item.startTs, item.endTs, zone) }),
      item.title ? el("div", { class: "tiny faint wrap", text: item.title }) : null),
    icon("chevron", "icon-sm"),
  );
}

function incomingCard(request: BookingRequest, refresh: Refresh): HTMLElement {
  const zone = store.timeZone();
  const requester = store.memberName(request.requesterUserId);
  const viaWaterfall = request.dayRequestId !== null;

  return el("div", { class: "card stack" },
    el("div", { class: "row-between" },
      el("div", { class: "grow" },
        el("h3", { text: `${requester} wants ${store.studioName(request.studioId)}` }),
        el("div", { class: "small dim num", text: formatTimeRange(request.startTs, request.endTs, zone) }),
        el("div", { class: "tiny faint", text: formatDayTitle(request.startTs, zone) })),
      el("span", { class: "pill pill-reserved", text: viaWaterfall ? "Day request" : "Open" })),

    el("div", { class: "row" },
      el("button", {
        class: "btn btn-quiet",
        onClick: () => void resolve(request.id, false, false, refresh),
      }, el("span", { text: "Decline" })),
      el("span", { class: "spacer" }),
      el("button", {
        class: "btn btn-secondary",
        onClick: () => void resolve(request.id, false, true, refresh),
      }, el("span", { text: "Keep" })),
      el("button", {
        class: "btn btn-primary",
        onClick: () => void resolve(request.id, true, false, refresh),
      }, el("span", { text: "Release" }))),

    el("div", { class: "tiny faint wrap" },
      el("span", { text: "Keep marks the time range as occupied, so nobody asks you again that day." })),
  );
}

function dayRequestCard(request: DayRequest, refresh: Refresh): HTMLElement {
  const zone = store.timeZone();
  const open = request.status === "pending";
  const granted = request.grantedStudioId === null ? null : store.studioName(request.grantedStudioId);

  return el("div", { class: "card stack" },
    el("div", { class: "row-between" },
      el("div", { class: "grow" },
        el("h3", { text: formatDayTitle(request.startTs, zone) }),
        el("div", { class: "small dim num", text: formatTimeRange(request.startTs, request.endTs, zone) }),
        el("div", { class: "tiny faint", text: request.scope === "cascade" ? "All studios, in priority order" : "Single studio" })),
      el("span", {
        class: `pill ${open ? "pill-reserved" : request.status === "fulfilled" ? "pill-free" : "pill-muted"}`,
        text: DAY_REQUEST_STATUS[request.status],
      })),

    granted !== null
      ? el("div", { class: "row" }, icon("check", "icon-sm"),
          el("span", { class: "small", text: `You are booked into ${granted}.` }))
      : null,

    open && request.provisionalBookingId !== null
      ? el("div", { class: "row" }, icon("layers", "icon-sm"),
          el("span", { class: "tiny dim", text: "A fallback room is held for you while the request is open." }))
      : null,

    open
      ? el("div", { class: "row-between" },
          el("span", { class: "tiny faint", text: "Waiting for the regular users to release a room." }),
          el("button", {
            class: "btn btn-quiet",
            onClick: async () => {
              const done = await run(() => api.cancelDayRequest(request.id));
              await refresh();
              if (done !== null) toast("Day request withdrawn.");
            },
          }, el("span", { text: "Withdraw" })))
      : null,
  );
}

function outgoingRow(request: BookingRequest, refresh: Refresh): HTMLElement {
  const zone = store.timeZone();
  return el("div", { class: "card stack" },
    el("div", { class: "row-between" },
      el("div", { class: "grow" },
        el("h3", { text: store.studioName(request.studioId) }),
        el("div", { class: "small dim num", text: formatTimeRange(request.startTs, request.endTs, zone) })),
      el("span", { class: "pill pill-muted", text: "Waiting" })),
    el("div", { class: "row-between" },
      el("span", { class: "tiny faint", text: `Waiting for ${store.memberName(request.bookingOwnerUserId)}` }),
      el("button", {
        class: "btn btn-quiet",
        onClick: async () => {
          const done = await run(() => api.cancelRequest(request.id));
          await refresh();
          if (done !== null) toast("Request withdrawn.");
        },
      }, el("span", { text: "Withdraw" }))),
  );
}

function notificationRow(entry: AppNotification): HTMLElement {
  const zone = store.timeZone();
  return el("div", { class: entry.readAt === null ? "list-item notification-unread" : "list-item" },
    icon("bell", "icon-sm"),
    el("div", { class: "grow" },
      el("div", { class: "small wrap", text: entry.title }),
      el("div", { class: "tiny dim wrap", text: entry.body }),
      el("div", { class: "tiny faint", text: `${formatDayTitle(entry.createdAt, zone)}, ${formatTime(entry.createdAt, zone)}` })),
  );
}

async function resolve(id: string, accept: boolean, keep: boolean, refresh: Refresh): Promise<void> {
  const done = await run(() => api.resolveRequest(id, accept, keep));
  await refresh();
  if (done === null) return;
  toast(accept ? "Time range released." : keep ? "Time range kept." : "Request declined.");
}
