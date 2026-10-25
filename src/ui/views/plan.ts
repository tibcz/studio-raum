import type { Booking, DayState, Studio } from "../../domain/models";
import { BOOKING_STATE_TITLE, DAY_STATE_HINT, DAY_STATE_TITLE } from "../../domain/models";
import { addDays, weekdayOf } from "../../domain/time";
import { formatDayTitle, formatShortDay, formatTimeRange } from "../../domain/format";
import { el, icon } from "../dom";
import { openSheet } from "../ui";
import * as store from "../state";
import { openBookingDetail, openBookingEditor, openDayRequest } from "./booking-sheets";

type Refresh = () => Promise<void>;

export const DAY_STATE_CLASS: Record<DayState, string> = {
  free: "pill-free",
  partial: "pill-partial",
  reserved: "pill-reserved",
  occupied: "pill-occupied",
};

export function planTopBar(refresh: Refresh): HTMLElement {
  const zone = store.timeZone();
  const today = store.today();
  const selected = store.state.selectedDay;

  const strip = el("div", { class: "daystrip", role: "tablist" });
  for (let offset = -2; offset <= 27; offset++) {
    const day = addDays(today, offset, zone);
    const isToday = offset === 0;
    const isSelected = day === selected;
    const weekday = weekdayOf(day, zone);
    const weekend = weekday === 0 || weekday === 6;

    strip.appendChild(
      el("button", {
        class: [
          "day",
          isSelected ? "day-selected" : "",
          weekend ? "day-weekend" : "",
        ].filter(Boolean).join(" "),
        ariaLabel: formatDayTitle(day, zone),
        onClick: () => store.update({ selectedDay: day }),
      },
        el("div", { text: isToday ? "Today" : formatShortDay(day, zone) }),
        isToday ? null : el("div", { class: "tiny", text: monthShort(day, zone) }),
      ),
    );
  }

  const selectedWeekday = weekdayOf(selected, zone);
  const selectedIsWeekend = selectedWeekday === 0 || selectedWeekday === 6;

  return el("div", { class: "topbar" },
    el("div", { class: "topbar-inner" },
      strip,
      el("div", { class: "row-between" },
        el("strong", {
          class: selectedIsWeekend ? "small day-title-weekend" : "small",
          text: formatDayTitle(selected, zone),
        }),
        el("button", {
          class: "btn btn-quiet", ariaLabel: "Refresh the room plan",
          onClick: () => void refresh(),
        }, icon("refresh", "icon-sm")),
      ),
    ),
  );
}

function monthShort(ts: number, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: zone }).format(new Date(ts * 1000));
}

export function planView(refresh: Refresh): HTMLElement {
  const screen = el("div", { class: "screen stack" });
  const studios = store.studiosByPriority();
  const day = store.state.selectedDay;

  if (!store.canWrite()) {
    screen.appendChild(
      el("div", { class: "banner" }, icon("eye"),
        el("span", { text: "View-only access · You can look at the plan but not book" })),
    );
  }

  if (studios.length === 0) {
    screen.appendChild(
      el("div", { class: "empty", text: "No studios yet. An admin can add them in Settings." }),
    );
    return screen;
  }

  const grid = el("div", { class: "studio-grid" });
  for (const studio of studios) {
    grid.appendChild(studioCard(studio, day, refresh));
  }
  screen.appendChild(grid);

  if (store.canWrite()) {
    screen.appendChild(
      el("button", {
        class: "btn btn-primary btn-block",
        onClick: () => openDayRequest(day, null, refresh),
      }, icon("layers"), el("span", { text: "Request a day" })),
    );
    screen.appendChild(
      el("p", { class: "tiny faint center" },
        "A day request goes to every room you would prefer, and meanwhile " +
        "holds the best free room for you."),
    );
  }

  screen.appendChild(legend());
  return screen;
}

function legend(): HTMLElement {
  const entry = (value: DayState) =>
    el("div", { class: "legend-entry" },
      el("span", { class: `dot ${DAY_STATE_CLASS[value]}` }),
      el("span", { class: "tiny", text: DAY_STATE_TITLE[value] }));

  return el("div", { class: "legend" },
    entry("free"), entry("partial"), entry("reserved"), entry("occupied"));
}

function studioCard(studio: Studio, day: number, refresh: Refresh): HTMLElement {
  const zone = store.timeZone();
  const bookings = store.bookingsFor(studio.id, day);
  const state = store.dayStateFor(studio.id, day);
  const free = store.freeSlotsFor(studio.id, day);

  const header = el("div", { class: "row-between" },
    el("div", { class: "grow" },
      el("h3", { text: studio.name }),
      studio.subtitle ? el("div", { class: "tiny dim", text: studio.subtitle }) : null),
    el("span", { class: `pill ${DAY_STATE_CLASS[state]}`, text: DAY_STATE_TITLE[state] }),
  );

  const body = bookings.length === 0
    ? el("div", { class: "small dim", text: "Free all day" })
    : el("div", {}, ...bookings.flatMap((item, index) => [
        index > 0 ? el("div", { class: "divider" }) : null,
        bookingLine(item, bookings.length > 1),
      ].filter(Boolean) as Node[]));

  const remainder = state === "partial" && free.length > 0
    ? el("div", { class: "tiny faint wrap" },
        el("span", { text: `Free: ${free.map((gap) => formatTimeRange(gap.start, gap.end, zone)).join(" · ")}` }))
    : null;

  return el("button", {
    class: `card studio-card stack card-${state}`,
    onClick: () => openStudioDay(studio, day, refresh),
  }, header, body, remainder);
}

export function bookingLine(item: Booking, withState = true): HTMLElement {
  const mine = item.ownerUserId === store.currentUserId();
  return el("div", { class: "booking-line" },
    el("div", { class: `booking-bar bar-${item.state}` }),
    el("div", { class: "grow" },
      el("div", { class: "booking-time", text: formatTimeRange(item.startTs, item.endTs, store.timeZone()) }),
      el("div", { class: "small dim" },
        el("span", { text: store.memberName(item.ownerUserId) }),
        item.origin === "standing" ? el("span", { class: "tiny faint", text: " · Standing" }) : null,
        item.origin === "provisional" ? el("span", { class: "tiny faint", text: " · Hold" }) : null)),
    mine ? el("span", { class: "pill", text: "You" }) : null,
    withState
      ? el("span", {
          class: `pill ${item.state === "occupied" ? "pill-occupied" : "pill-reserved"}`,
          text: BOOKING_STATE_TITLE[item.state],
        })
      : null,
  );
}

function openStudioDay(studio: Studio, day: number, refresh: Refresh): void {
  const zone = store.timeZone();

  openSheet(studio.name, (handle) => {
    const bookings = store.bookingsFor(studio.id, day);
    const free = store.freeSlotsFor(studio.id, day);
    const state = store.dayStateFor(studio.id, day);

    return [
      el("div", { class: "row-between" },
        el("div", { class: "section-title", text: formatDayTitle(day, zone) }),
        el("span", { class: `pill ${DAY_STATE_CLASS[state]}`, text: DAY_STATE_TITLE[state] })),
      el("p", { class: "small dim", text: DAY_STATE_HINT[state] }),

      bookings.length === 0
        ? null
        : el("div", { class: "card list" }, ...bookings.map((item) =>
            el("button", {
              class: "list-item",
              onClick: () => { handle.close(); openBookingDetail(item, refresh); },
            }, el("div", { class: "grow" }, bookingLine(item)), icon("chevron", "icon-sm")))),

      ...(store.canWrite()
        ? [
            free.length === 0
              ? null
              : el("div", { class: "section-title", text: "Free times" }),
            ...free.map((gap) =>
              el("button", {
                class: "btn btn-secondary btn-block",
                onClick: () => {
                  handle.close();
                  openBookingEditor(studio, day, refresh, undefined, gap);
                },
              }, icon("plus"),
                el("span", { text: `Book ${formatTimeRange(gap.start, gap.end, zone)}` }))),

            el("button", {
              class: "btn btn-primary btn-block",
              onClick: () => { handle.close(); openDayRequest(day, studio.id, refresh); },
            }, icon("arrow"), el("span", { text: `Request ${studio.name}` })),
            el("p", { class: "tiny faint" },
              "A request only reaches people who booked as \u201creserved\u201d. " +
              "An occupied time range cannot be requested."),
          ]
        : [
            el("div", { class: "banner" }, icon("eye"),
              el("span", { text: "With view-only access you can only look at the plan." })),
          ]),
    ];
  });
}
