import type { Booking, BookingState, Studio } from "../../domain/models";
import { BOOKING_STATE_HINT, BOOKING_STATE_TITLE } from "../../domain/models";
import {
  INPUT_STEP_SECONDS, SLOT_SECONDS, initialRange, snappedRangeToStep, type Interval,
} from "../../domain/booking-rules";
import { formatDayTitle, formatTimeRange } from "../../domain/format";
import { el, icon, type Child } from "../dom";
import { api } from "../api";
import { confirmSheet, field, openSheet, run, toast, type SheetHandle } from "../ui";
import * as store from "../state";
import { durationText, fromInputs, toDateInput, toTimeInput } from "../datetime";

type Refresh = () => Promise<void>;

const STEP = String(INPUT_STEP_SECONDS);

function stateChooser(initial: BookingState): { node: HTMLElement; value: () => BookingState } {
  let selected = initial;
  const wrapper = el("div", { class: "stack" });
  const hint = el("div", { class: "tiny faint" });

  function render() {
    hint.textContent = BOOKING_STATE_HINT[selected];
    wrapper.replaceChildren(
      el("div", { class: "segmented" },
        ...(["occupied", "reserved"] as BookingState[]).map((value) =>
          el("button", {
            type: "button",
            class: [
              "segment",
              `segment-${value}`,
              selected === value ? "segment-active" : "",
            ].filter(Boolean).join(" "),
            text: BOOKING_STATE_TITLE[value],
            onClick: () => { selected = value; render(); },
          }))),
      hint,
    );
  }
  render();

  return { node: wrapper, value: () => selected };
}

export function openBookingEditor(
  studio: Studio, day: number, refresh: Refresh, existing?: Booking, preset?: Interval,
): void {
  const zone = store.timeZone();
  const range = existing
    ? { start: existing.startTs, end: existing.endTs }
    : preset
      ? snappedRangeToStep(preset.start, preset.end)
      : snappedRangeToStep(initialRange(day, zone).start, initialRange(day, zone).end);

  const dateInput = el("input", { type: "date", value: toDateInput(range.start, zone) });
  const startInput = el("input", { type: "time", step: STEP, value: toTimeInput(range.start, zone) });
  const endInput = el("input", { type: "time", step: STEP, value: toTimeInput(range.end, zone) });
  const titleInput = el("input", {
    type: "text", placeholder: "e.g. Recording", maxLength: 500, value: existing?.title ?? "",
  });
  const chooser = stateChooser(existing?.state ?? "occupied");
  const preview = el("div", { class: "tiny faint" });

  function currentRange(): { start: number; end: number } | null {
    const start = fromInputs(dateInput.value, startInput.value, zone);
    let end = fromInputs(dateInput.value, endInput.value, zone);
    if (start === null || end === null) return null;
    if (end <= start) end += 24 * 3600;
    return snappedRangeToStep(start, end);
  }

  function updatePreview() {
    const value = currentRange();
    preview.textContent = value === null
      ? "Please enter the date and time completely."
      : `You are booking ${formatTimeRange(value.start, value.end, zone)} · ` +
        `${durationText(value.end - value.start)} · in 30-minute steps.`;
  }

  for (const input of [dateInput, startInput, endInput]) {
    input.addEventListener("change", updatePreview);
    input.addEventListener("input", updatePreview);
  }
  updatePreview();

  openSheet(existing ? "Change booking" : "Book a studio", (handle) => [
    el("div", { class: "row" }, icon("door"),
      el("strong", { text: studio.name }),
      el("span", { class: "spacer" }),
      el("span", { class: "small dim", text: formatDayTitle(range.start, zone) })),

    field("Day", dateInput),
    el("div", { class: "field-row" },
      field("From", startInput),
      field("To", endInput)),
    el("div", { class: "field" }, preview),
    field("Note (optional)", titleInput),

    el("div", { class: "field" },
      el("label", { text: "State" }),
      chooser.node),

    saveButton(existing ? "Save" : "Book", handle, async () => {
      const value = currentRange();
      if (value === null) {
        toast("Please enter the date and time completely.", "error");
        return false;
      }
      const done = await run(() => existing
        ? api.updateBooking(existing.id, studio.id, value.start, value.end, titleInput.value, chooser.value())
        : api.createBooking(studio.id, value.start, value.end, titleInput.value, chooser.value()));
      if (done === null) {
        await refresh();
        return false;
      }
      await refresh();
      toast(existing ? "Booking changed." : "Studio booked.");
      return true;
    }),
  ]);
}

export function openBookingDetail(item: Booking, refresh: Refresh): void {
  const zone = store.timeZone();
  const studio = store.studio(item.studioId);
  const mine = item.ownerUserId === store.currentUserId();

  openSheet("Booking", (handle) => [
    el("div", { class: "card stack" },
      el("div", { class: "row" }, icon("door"),
        el("div", { class: "grow" },
          el("h3", { text: studio?.name ?? "Studio" }),
          el("div", { class: "small dim", text: formatDayTitle(item.startTs, zone) })),
        el("span", {
          class: `pill ${item.state === "occupied" ? "pill-occupied" : "pill-reserved"}`,
          text: BOOKING_STATE_TITLE[item.state],
        }),
      ),
      el("div", { class: "divider" }),
      el("div", { class: "booking-time num", text: formatTimeRange(item.startTs, item.endTs, zone) }),
      el("div", { text: store.memberName(item.ownerUserId) }),
      item.title ? el("div", { class: "small dim wrap", text: item.title }) : null,
      item.origin === "standing"
        ? el("div", { class: "row" }, icon("repeat", "icon-sm"),
            el("span", { class: "tiny dim", text: "From the standing booking. Deleting only applies to this day." }))
        : null,
      item.origin === "provisional"
        ? el("div", { class: "row" }, icon("layers", "icon-sm"),
            el("span", { class: "tiny dim", text: "Hold from a day request." }))
        : null,
      el("div", { class: "tiny faint", text: BOOKING_STATE_HINT[item.state] }),
    ),

    ...(!store.canWrite()
      ? [el("div", { class: "banner" }, icon("eye"),
          el("span", { text: "With view-only access you can only look at the plan." }))]
      : mine
        ? [
            ...stateToggle(item, handle, refresh),
            ...ownerActions(item, studio, handle, refresh, "Adjust the time window", true),
          ]
        : [
            ...(item.state === "reserved"
              ? [
                  el("button", {
                    class: "btn btn-primary btn-block",
                    onClick: () => { handle.close(); openRequestEditor(item, refresh); },
                  }, icon("arrow"), el("span", { text: "Request the time range" })),
                  el("p", { class: "tiny faint center" },
                    `${store.memberName(item.ownerUserId)} decides on your request. ` +
                    "Until then the time range stays unchanged."),
                ]
              : [
                  el("div", { class: "banner" }, icon("warn"),
                    el("span", { text: "This time range is occupied. Requests are not possible here." })),
                ]),
            ...(store.isBookingManager()
              ? [
                  el("div", { class: "section-title", text: "As admin" }),
                  ...ownerActions(item, studio, handle, refresh, "Change someone else's booking", false),
                  el("p", { class: "tiny faint" },
                    "These two actions change someone else's booking without asking."),
                ]
              : []),
          ]),
  ]);
}

function stateToggle(item: Booking, handle: SheetHandle, refresh: Refresh): Child[] {
  const next: BookingState = item.state === "occupied" ? "reserved" : "occupied";
  return [
    el("button", {
      class: "btn btn-secondary btn-block",
      onClick: async () => {
        const done = await run(() => api.setBookingState(item.id, next));
        if (done !== null) {
          handle.close();
          await refresh();
          toast(next === "occupied" ? "Marked as occupied." : "Opened for requests.");
        }
      },
    },
      icon(next === "occupied" ? "warn" : "arrow"),
      el("span", {
        text: next === "occupied"
          ? "Occupied: no more requests"
          : "Open for requests",
      })),
  ];
}

function ownerActions(
  item: Booking,
  studio: Studio | undefined,
  handle: SheetHandle,
  refresh: Refresh,
  editLabel: string,
  primary: boolean,
): Child[] {
  return [
    el("button", {
      class: primary ? "btn btn-primary btn-block" : "btn btn-secondary btn-block",
      onClick: () => {
        handle.close();
        if (studio) openBookingEditor(studio, item.startTs, refresh, item);
      },
    }, el("span", { text: editLabel })),
    el("button", {
      class: "btn btn-danger btn-block",
      onClick: () => {
        handle.close();
        confirmSheet({
          title: "Really release the booking?",
          message: item.origin === "standing"
            ? "Afterwards the time range can be booked by everyone right away. The standing " +
              "booking stays and keeps applying on the other days."
            : "Afterwards the time range can be booked by all members right away.",
          confirmLabel: "Delete booking",
          danger: true,
          onConfirm: async () => {
            const done = await run(() => api.deleteBooking(item.id));
            await refresh();
            if (done !== null) toast("Time range released.");
          },
        });
      },
    }, icon("trash"), el("span", { text: "Release the time range" })),
  ];
}

export function openRequestEditor(item: Booking, refresh: Refresh): void {
  const zone = store.timeZone();
  const startInput = el("input", { type: "time", step: STEP, value: toTimeInput(item.startTs, zone) });
  const endInput = el("input", { type: "time", step: STEP, value: toTimeInput(item.endTs, zone) });
  const preview = el("div", { class: "tiny faint" });

  function currentRange(): { start: number; end: number } | null {
    const day = toDateInput(item.startTs, zone);
    const rawStart = fromInputs(day, startInput.value, zone);
    let rawEnd = fromInputs(day, endInput.value, zone);
    if (rawStart === null || rawEnd === null) return null;
    if (rawEnd <= rawStart) rawEnd += 24 * 3600;

    const snapped = snappedRangeToStep(rawStart, rawEnd);
    const start = Math.min(Math.max(snapped.start, item.startTs), item.endTs - SLOT_SECONDS);
    const end = Math.min(Math.max(snapped.end, start + SLOT_SECONDS), item.endTs);
    return { start, end };
  }

  function updatePreview() {
    const value = currentRange();
    preview.textContent = value === null
      ? "Please enter valid times."
      : `You are requesting ${formatTimeRange(value.start, value.end, zone)}.`;
  }

  for (const input of [startInput, endInput]) {
    input.addEventListener("change", updatePreview);
    input.addEventListener("input", updatePreview);
  }
  updatePreview();

  openSheet("Request a time range", (handle) => [
    el("div", { class: "card stack" },
      row("Studio", store.studioName(item.studioId)),
      row("Booked by", store.memberName(item.ownerUserId)),
      row("Booking", formatTimeRange(item.startTs, item.endTs, zone)),
    ),
    el("div", { class: "field-row" },
      field("From", startInput),
      field("To", endInput)),
    el("div", { class: "field" }, preview),

    saveButton("Send request", handle, async () => {
      const value = currentRange();
      if (value === null) {
        toast("Please enter valid times.", "error");
        return false;
      }
      const done = await run(() => api.createRequest(item.id, value.start, value.end));
      if (done === null) return false;
      await refresh();
      toast("Request sent.");
      return true;
    }),
  ]);
}

export function openDayRequest(day: number, studioId: string | null, refresh: Refresh): void {
  const zone = store.timeZone();
  const suggestion = snappedRangeToStep(initialRange(day, zone).start, initialRange(day, zone).end);

  const startInput = el("input", { type: "time", step: STEP, value: toTimeInput(suggestion.start, zone) });
  const endInput = el("input", { type: "time", step: STEP, value: toTimeInput(suggestion.end, zone) });
  const noteInput = el("input", {
    type: "text", placeholder: "e.g. Vocals with a band", maxLength: 500,
  });

  const studios = store.studiosByPriority();
  const scopeSelect = el("select", { ariaLabel: "Which studios?" },
    el("option", { value: "", text: "All studios, in your priority order" }),
    ...studios.map((studio) => el("option", { value: studio.id, text: studio.name })));
  scopeSelect.value = studioId ?? "";

  const preview = el("div", { class: "stack" });

  function currentRange(): { start: number; end: number } | null {
    const date = toDateInput(day, zone);
    const start = fromInputs(date, startInput.value, zone);
    let end = fromInputs(date, endInput.value, zone);
    if (start === null || end === null) return null;
    if (end <= start) end += 24 * 3600;
    return snappedRangeToStep(start, end);
  }

  function renderPreview() {
    const value = currentRange();
    if (value === null) {
      preview.replaceChildren(el("div", { class: "tiny faint", text: "Please enter valid times." }));
      return;
    }

    const chosen = scopeSelect.value;
    const all = store.assessWindow(value.start, value.end);
    const relevant = chosen === "" ? all : all.filter((entry) => entry.studio.id === chosen);
    const firstFree = relevant.findIndex((entry) => entry.free);
    const targets = relevant
      .slice(0, firstFree < 0 ? relevant.length : firstFree)
      .filter((entry) => entry.requestable);

    const nothingReachable = targets.length === 0 && firstFree < 0;
    preview.replaceChildren(
      el("div", { class: "section-title", text: "What will happen" }),
      el("div", { class: "card list" },
        ...relevant.map((entry, index) => {
          const isFallback = index === firstFree;
          const isTarget = targets.includes(entry);
          const label = entry.free
            ? (isFallback ? (targets.length === 0 ? "Booked directly" : "Held for you") : "Free")
            : entry.mine ? "Already yours"
            : isTarget ? `Request to ${entry.owners.join(", ")}`
            : entry.requestable ? "Can be requested, but not preferred"
            : "Occupied: no request possible";
          const tone = entry.free ? "pill-free"
            : entry.mine ? "pill-muted"
            : entry.requestable ? "pill-reserved"
            : "pill-occupied";
          return el("div", { class: "list-item" },
            el("span", { class: `dot ${tone}` }),
            el("div", { class: "grow" },
              el("div", { class: "small", text: entry.studio.name }),
              el("div", { class: "tiny dim wrap", text: label })));
        })),
      ...(nothingReachable
        ? [el("div", { class: "banner banner-warn" }, icon("warn"),
            el("span", { text: "No room is free in this time range and none can be requested." }))]
        : []),
    );
  }

  for (const input of [startInput, endInput]) {
    input.addEventListener("change", renderPreview);
    input.addEventListener("input", renderPreview);
  }
  scopeSelect.addEventListener("change", renderPreview);
  renderPreview();

  openSheet("Request a day", (handle) => [
    el("div", { class: "row" }, icon("clock"),
      el("strong", { text: formatDayTitle(day, zone) })),

    el("div", { class: "field-row" },
      field("From", startInput),
      field("To", endInput)),
    field("Which studios?", scopeSelect,
      "Requests follow your priority order. You set it in Settings."),
    field("Note (optional)", noteInput),

    preview,

    saveButton("Send request", handle, async () => {
      const value = currentRange();
      if (value === null) {
        toast("Please enter valid times.", "error");
        return false;
      }
      const done = await run(() => api.createDayRequest(
        value.start, value.end, scopeSelect.value === "" ? null : scopeSelect.value, noteInput.value,
      ));
      if (done === null) return false;
      await refresh();
      toast(done.status === "fulfilled" ? "Studio booked directly." : "Request sent.");
      return true;
    }),
  ]);
}

function row(label: string, value: string): HTMLElement {
  return el("div", { class: "row-between" },
    el("span", { class: "small dim", text: label }),
    el("span", { class: "small", text: value }));
}

function saveButton(
  label: string, handle: SheetHandle, action: () => Promise<boolean>,
): HTMLElement {
  let sending = false;
  const button = el("button", { class: "btn btn-primary btn-block" }, el("span", { text: label }));
  button.addEventListener("click", async () => {
    if (sending) return;
    sending = true;
    button.toggleAttribute("disabled", true);
    const done = await action();
    sending = false;
    button.toggleAttribute("disabled", false);
    if (done) handle.close();
  });
  return button;
}
