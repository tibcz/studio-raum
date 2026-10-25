import type { DayState, Studio } from "../../domain/models";
import { DAY_STATE_TITLE, WEEKDAY_SHORT, isWeekendDay } from "../../domain/models";
import { type Interval } from "../../domain/booking-rules";
import { addDays, weekdayOf, zonedParts, zonedTimestamp } from "../../domain/time";
import { api } from "../api";
import { field, openSheet, run, toast } from "../ui";
import { formatDayTitle, formatTimeRange } from "../../domain/format";
import { append, el, icon, type Child } from "../dom";
import * as store from "../state";
import { DAY_STATE_CLASS } from "./plan";

type Refresh = () => Promise<void>;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

interface CalendarDay {
  window: Interval;
  weekday: number;
  dayOfMonth: number;
  isToday: boolean;
  isPast: boolean;
}

export function calendarTopBar(refresh: Refresh): HTMLElement {
  const zone = store.timeZone();
  const parts = zonedParts(store.state.calendarMonth, zone);

  const step = (months: number) => {
    const shifted = zonedTimestamp(parts.year, parts.month + months, 1, 12, 0, 0, zone);
    store.update({ calendarMonth: shifted });
  };

  return el("div", { class: "topbar" },
    el("div", { class: "topbar-inner" },
      el("div", { class: "row-between" },
        el("button", { class: "btn btn-quiet", ariaLabel: "Previous month", onClick: () => step(-1) },
          icon("back", "icon-sm")),
        el("strong", { text: `${MONTHS[parts.month - 1]} ${parts.year}` }),
        el("button", { class: "btn btn-quiet", ariaLabel: "Next month", onClick: () => step(1) },
          icon("chevron", "icon-sm")),
      ),
      el("div", { class: "row-between" },
        el("button", {
          class: "btn btn-quiet",
          onClick: () => store.update({ calendarMonth: Math.floor(Date.now() / 1000) }),
        }, el("span", { text: "Today" })),
        el("div", { class: "row" },
          store.canWrite()
            ? el("button", {
                class: store.state.calendarSelecting ? "btn btn-quiet btn-on" : "btn btn-quiet",
                onClick: () => store.state.calendarSelecting
                  ? store.clearDaySelection()
                  : store.update({ calendarSelecting: true }),
              }, el("span", { text: store.state.calendarSelecting ? "Done" : "Select" }))
            : null,
          el("button", {
            class: "btn btn-quiet", ariaLabel: "Refresh the calendar",
            onClick: () => void refresh(),
          }, icon("refresh", "icon-sm")),
        ),
      ),
    ),
  );
}

export function calendarView(refresh: Refresh): HTMLElement {
  const screen = el("div", {
    class: store.state.calendarSelecting ? "screen stack screen-selecting" : "screen stack",
  });
  const studios = store.studiosByPriority();

  if (studios.length === 0) {
    screen.appendChild(el("div", { class: "empty", text: "No studios yet." }));
    return screen;
  }

  const selected = studios.find((s) => s.id === store.state.calendarStudioId) ?? null;
  const days = monthDays(store.state.calendarMonth);

  append(screen, [
    studioChooser(studios, selected),
    store.state.calendarSelecting ? selectionHint() : null,
    grid(days, selected === null ? studios : [selected]),
    horizonNote(days),
    selected === null ? studioKey(studios) : selectedStudioSummary(selected, days),
    legend(),
    store.state.calendarSelecting ? selectionBar(studios, selected, refresh) : null,
  ]);
  return screen;
}

function selectionHint(): HTMLElement {
  return el("div", { class: "banner" }, icon("clock"),
    el("span", {
      text: "Tap the days that should become free. They do not have to follow each other, " +
        "and you can change the month without losing the selection.",
    }));
}

function selectionBar(studios: Studio[], selected: Studio | null, refresh: Refresh): HTMLElement {
  const count = store.state.calendarSelection.length;

  return el("div", { class: "selection-bar" },
    el("div", { class: "grow" },
      el("div", { class: "small", text: count === 1 ? "1 day selected" : `${count} days selected` }),
      el("div", { class: "tiny faint", text: "Releasing deletes the bookings on these days." })),
    el("button", {
      class: "btn btn-quiet", disabled: count === 0,
      onClick: () => store.update({ calendarSelection: [] }),
    }, el("span", { text: "Clear" })),
    el("button", {
      class: "btn btn-primary", disabled: count === 0,
      onClick: () => openRelease(studios, selected, refresh),
    }, icon("arrow"), el("span", { text: "Release" })),
  );
}

function studioChooser(studios: Studio[], selected: Studio | null): HTMLElement {
  const choose = (id: string | null) => store.update({ calendarStudioId: id });

  return el("div", { class: "chooser" },
    el("button", {
      class: selected === null ? "chip chip-active" : "chip",
      text: "All studios",
      onClick: () => choose(null),
    }),
    ...studios.map((studio) =>
      el("button", {
        class: selected?.id === studio.id ? "chip chip-active" : "chip",
        text: studio.name,
        onClick: () => choose(studio.id),
      })),
  );
}

function monthDays(inMonth: number): CalendarDay[] {
  const zone = store.timeZone();
  const parts = zonedParts(inMonth, zone);
  const today = store.today();
  const now = Math.floor(Date.now() / 1000);

  const days: CalendarDay[] = [];
  let cursor = zonedTimestamp(parts.year, parts.month, 1, 0, 0, 0, zone);
  while (zonedParts(cursor, zone).month === parts.month) {
    const next = addDays(cursor, 1, zone);
    days.push({
      window: { start: cursor, end: next },
      weekday: weekdayOf(cursor, zone),
      dayOfMonth: zonedParts(cursor, zone).day,
      isToday: cursor === today,
      isPast: next <= now,
    });
    cursor = next;
  }
  return days;
}

function grid(days: CalendarDay[], studios: Studio[]): HTMLElement {
  const table = el("div", { class: "cal", role: "grid" });

  for (const weekday of [1, 2, 3, 4, 5, 6, 0]) {
    table.appendChild(el("div", {
      class: isWeekendDay(weekday) ? "cal-head cal-weekend" : "cal-head",
      text: WEEKDAY_SHORT[weekday],
    }));
  }

  const lead = days[0] === undefined ? 0 : (days[0].weekday + 6) % 7;
  for (let index = 0; index < lead; index++) {
    table.appendChild(el("div", { class: "cal-cell cal-empty" }));
  }

  for (const day of days) table.appendChild(cell(day, studios));
  return table;
}

function cell(day: CalendarDay, studios: Studio[]): HTMLElement {
  const states = studios.map((studio) => ({
    studio,
    state: store.dayStateInWindow(studio.id, day.window),
  }));

  const single = states.length === 1 ? states[0]!.state : null;

  const selecting = store.state.calendarSelecting;
  const isSelected = store.isDaySelected(day.window.start);

  const classes = [
    "cal-cell",
    single === null ? "" : `cal-${single}`,
    isWeekendDay(day.weekday) ? "cal-weekend" : "",
    day.isToday ? "cal-today" : "",
    day.isPast ? "cal-past" : "",
    isSelected ? "cal-selected" : "",
  ].filter(Boolean).join(" ");

  const label = single === null
    ? states.map((entry) => `${entry.studio.name}: ${DAY_STATE_TITLE[entry.state]}`).join(", ")
    : DAY_STATE_TITLE[single];

  return el("button", {
    class: classes,
    ariaLabel: `${formatDayTitle(day.window.start, store.timeZone())}: ${label}`,
    ...(selecting ? { ariaPressed: isSelected } : {}),
    disabled: selecting && day.isPast,
    onClick: () => selecting
      ? store.toggleDaySelection(day.window.start)
      : store.update({ selectedDay: day.window.start, tab: "plan" }),
  },
    el("span", { class: "cal-num", text: day.dayOfMonth }),
    single === null
      ? el("span", { class: "cal-bars" },
          ...states.map((entry) => el("span", { class: `cal-bar bar-cal-${entry.state}` })))
      : null,
  );
}

function studioKey(studios: Studio[]): HTMLElement {
  return el("div", { class: "card stack" },
    el("div", { class: "section-title", text: "Order of the bars" }),
    el("div", { class: "list" },
      ...studios.map((studio, index) =>
        el("div", { class: "list-item" },
          el("span", { class: "rank num", text: `${index + 1}` }),
          el("span", { class: "grow", text: studio.name }),
          studio.subtitle ? el("span", { class: "tiny dim", text: studio.subtitle }) : null))),
    el("p", { class: "tiny faint" },
      "One bar per studio, from top to bottom in your priority order. " +
      "Tap a studio above to see it on its own."),
  );
}

function selectedStudioSummary(studio: Studio, days: CalendarDay[]): HTMLElement {
  const zone = store.timeZone();
  const open = days.filter((day) => {
    if (day.isPast) return false;
    const state = store.dayStateInWindow(studio.id, day.window);
    return state === "free" || state === "partial";
  });

  return el("div", { class: "card stack" },
    el("div", { class: "section-title", text: `Still free in ${studio.name}` }),
    open.length === 0
      ? el("div", { class: "empty", text: "Nothing is free any more this month." })
      : el("div", { class: "list" }, ...open.slice(0, 12).map((day) => {
          const gaps = store.freeSlotsFor(studio.id, day.window.start);
          return el("button", {
            class: "list-item",
            onClick: () => store.update({ selectedDay: day.window.start, tab: "plan" }),
          },
            el("span", {
              class: isWeekendDay(day.weekday) ? "weekday-chip weekday-weekend" : "weekday-chip",
              text: WEEKDAY_SHORT[day.weekday] ?? "",
            }),
            el("div", { class: "grow" },
              el("div", { class: "small", text: formatDayTitle(day.window.start, zone) }),
              el("div", { class: "tiny dim num wrap",
                text: gaps.map((gap) => formatTimeRange(gap.start, gap.end, zone)).join(" · ") })),
            icon("chevron", "icon-sm"));
        })),
    open.length > 12
      ? el("p", { class: "tiny faint", text: `And ${open.length - 12} more days.` })
      : null,
  );
}

function horizonNote(days: CalendarDay[]): Child {
  if (store.standingRules().length === 0) return null;
  const horizon = store.standingHorizon();
  const last = days[days.length - 1];
  if (last === undefined || last.window.end <= horizon) return null;

  const first = days.find((day) => day.window.start >= horizon);
  const zone = store.timeZone();
  return el("div", { class: "banner" }, icon("clock"),
    el("span", {
      text: first === undefined
        ? "The standing bookings are not entered for this month yet."
        : `From ${formatDayTitle(first.window.start, zone)} the standing bookings are ` +
          "not entered yet, so these days look freer than they are.",
    }));
}

function legend(): HTMLElement {
  const entry = (value: DayState) =>
    el("div", { class: "legend-entry" },
      el("span", { class: `dot ${DAY_STATE_CLASS[value]}` }),
      el("span", { class: "tiny", text: DAY_STATE_TITLE[value] }));

  return el("div", { class: "legend" },
    entry("free"), entry("partial"), entry("reserved"), entry("occupied"));
}

function openRelease(studios: Studio[], selected: Studio | null, refresh: Refresh): void {
  const zone = store.timeZone();
  const days = [...store.state.calendarSelection].sort((a, b) => a - b);

  const studioSelect = el("select", { ariaLabel: "Which studio?" },
    ...studios.map((studio) => el("option", { value: studio.id, text: studio.name })));
  studioSelect.value = selected?.id ?? studios[0]?.id ?? "";

  const preview = el("div", { class: "stack" });

  function renderPreview(): void {
    const entries = store.releasePreview(studioSelect.value, days);
    const total = entries.reduce((sum, entry) => sum + entry.bookings.length, 0);
    const queued = entries.reduce((sum, entry) => sum + (entry.waiting.length > 0 ? 1 : 0), 0);

    const parts: Child[] = [
      el("div", { class: "section-title", text: "What will happen" }),
      total === 0
        ? el("div", { class: "empty", text: "On these days you have nothing here to release." })
        : el("div", { class: "card list" },
            ...entries.map((entry) => {
              const first = entry.waiting[0];
              const detail = entry.bookings.length === 0
                ? "Nothing to release"
                : entry.bookings
                    .map((b) => `${store.memberName(b.ownerUserId)}, ` +
                      `${formatTimeRange(b.startTs, b.endTs, zone)}`)
                    .join(" · ");

              return el("div", { class: "list-item" },
                el("span", {
                  class: isWeekendDay(weekdayOf(entry.day, zone)) ? "weekday-chip weekday-weekend" : "weekday-chip",
                  text: WEEKDAY_SHORT[weekdayOf(entry.day, zone)] ?? "",
                }),
                el("div", { class: "grow" },
                  el("div", { class: "small", text: formatDayTitle(entry.day, zone) }),
                  el("div", { class: "tiny dim wrap", text: detail }),
                  first === undefined
                    ? null
                    : el("div", { class: "tiny wrap queue-note" },
                        el("span", { class: "dot pill-free" }),
                        el("span", {
                          text: ` ${store.memberName(first.requesterUserId)} moves up` +
                            (entry.waiting.length > 1 ? `, ${entry.waiting.length - 1} more waiting` : ""),
                        }))));
            })),
      queued > 0
        ? el("p", { class: "tiny faint" },
            "Whoever asked first is booked right away. The others are told " +
            "that the room became free.")
        : null,
      total === 0
        ? null
        : el("div", { class: "banner banner-warn" }, icon("warn"),
            el("span", {
              text: (total === 1 ? "One booking will be" : `${total} bookings will be`) +
                " deleted. This cannot be undone.",
            })),
    ];
    preview.replaceChildren(...parts.filter((part): part is Node => part instanceof Node));
  }

  studioSelect.addEventListener("change", renderPreview);
  renderPreview();

  openSheet("Release days", (handle) => [
    el("div", { class: "row" }, icon("calendar"),
      el("strong", { text: days.length === 1 ? "1 day" : `${days.length} days` })),

    field("Which studio?", studioSelect,
      store.isBookingManager()
        ? "As an admin you also release the days of the others here."
        : "What you own on these days is released."),

    preview,

    el("button", {
      class: "btn btn-danger btn-block",
      onClick: async () => {
        const result = await run(() => api.releaseDays(studioSelect.value, days));
        if (result === null) return;
        handle.close();
        store.clearDaySelection();
        await refresh();
        const released = result.released === 1 ? "One booking" : `${result.released} bookings`;
        const movedUp = result.granted === 1
          ? "one request moved up"
          : `${result.granted} requests moved up`;
        toast(result.granted > 0
          ? `${released} released, ${movedUp}.`
          : `${released} released.`);
      },
    }, icon("arrow"), el("span", { text: "Release now" })),
  ]);
}
