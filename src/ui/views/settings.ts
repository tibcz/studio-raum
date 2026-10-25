import type { BookingState, JoinMode, StandingRule, Studio, TeamMember } from "../../domain/models";
import {
  BOOKING_STATE_HINT, BOOKING_STATE_TITLE, MEMBER_STATUS_TITLE, PLACEHOLDER_HINT,
  ROLE_TITLE, WEEKDAY_SHORT, WEEKDAY_TITLE, isWeekendDay, memberStatus,
} from "../../domain/models";
import { formatDayTitle, formatTime } from "../../domain/format";
import { el, icon, type Child } from "../dom";
import { api, instanceInfo, loadInstanceInfo, type StandingRuleInput } from "../api";
import { confirmSheet, copyButton, emptyState, field, openSheet, run, toast } from "../ui";
import * as store from "../state";
import { timeZoneOptions } from "../datetime";
import {
  currentSubscription, disablePush, enablePush, isAppleDevice, isInstalled,
  permissionState, pushSupported,
} from "../push";

type Refresh = () => Promise<void>;

const JOIN_MODES: ReadonlyArray<{ value: JoinMode; title: string; explanation: string }> = [
  {
    value: "closed",
    title: "Closed",
    explanation: "Nobody can join. The join secret is useless for now.",
  },
  {
    value: "view",
    title: "Join and view only",
    explanation: "Whoever has the secret sees the whole room plan with all names and notes. " +
      "They cannot book, change or delete anything.",
  },
  {
    value: "approval",
    title: "Join with approval",
    explanation: "Whoever has the secret can join and book after you approve them. " +
      "The secret works like a key: whoever passes it on passes the access on.",
  },
];

export function settingsView(refresh: Refresh, onSignedOut: () => void): HTMLElement {
  const snap = store.snapshot();
  const me = store.member(store.currentUserId());
  const screen = el("div", { class: "screen stack" });

  screen.append(el("h1", { text: "Settings" }));

  screen.append(
    el("div", { class: "section-title", text: "Account" }),
    el("div", { class: "card stack" },
      el("div", { class: "row-between" },
        el("div", { class: "row" }, icon("people"), el("span", { text: me?.displayName ?? "—" })),
        el("span", { class: "small dim", text: store.canWrite() ? ROLE_TITLE[snap.role] : "View only" })),
      el("button", {
        class: "btn btn-secondary btn-block",
        onClick: () => openSecretRotation(),
      }, icon("key"), el("span", { text: "Renew secret" })),
      el("button", {
        class: "btn btn-secondary btn-block",
        onClick: async () => {
          await run(() => api.logout());
          onSignedOut();
        },
      }, icon("logout"), el("span", { text: "Sign out" })),
    ),
  );

  screen.append(
    el("div", { class: "section-title", text: "Notifications" }),
    notificationCard(refresh),
  );

  if (store.canWrite()) {
    screen.append(
      el("div", { class: "section-title", text: "Your studio priority" }),
      priorityCard(refresh),
    );
  }

  screen.append(
    el("div", { class: "section-title", text: "Team" }),
    el("div", { class: "card list" },
      listRow("Name", snap.team.name),
      listRow("Time zone", snap.team.timeZone),
      navRow("Members", `${snap.members.length}`, () => openMembers(refresh),
        store.pendingMembers().length > 0 ? `${store.pendingMembers().length} open` : undefined),
      ...(store.isManager()
        ? [
            navRow("Joining and secret",
              JOIN_MODES.find((m) => m.value === snap.team.joinMode)?.title ?? "",
              () => openJoinSettings(refresh)),
            navRow("Edit team", "", () => openTeamEditor(refresh)),
          ]
        : []),
    ),
  );

  if (store.isManager()) {
    screen.append(
      el("div", { class: "section-title", text: "Administration" }),
      el("div", { class: "card list" },
        navRow("Standing bookings", `${store.standingRules().length}`, () => openStandingRules(refresh)),
        navRow("Manage studios", `${store.allStudios().length}`, () => openStudios(refresh)),
        navRow("Activity log", `${snap.activities.length}`, () => openActivityLog()),
      ),
      el("p", { class: "tiny faint" },
        "Standing bookings enter the regular users in advance, eight weeks ahead, " +
        "as \u201creserved\u201d so that they can be requested."),
    );
  }

  const isOwner = snap.role === "owner";
  screen.append(
    el("div", { class: "section-title", text: "Data" }),
    el("div", { class: "card stack" },
      el("button", { class: "btn btn-secondary btn-block", onClick: () => void exportData() },
        icon("download"), el("span", { text: "Export data" })),
      el("button", {
        class: "btn btn-danger btn-block",
        onClick: () => confirmSheet({
          title: isOwner ? "Delete the team and all data?" : "Delete your data and leave the team?",
          message: isOwner
            ? "This permanently deletes members, studios, bookings, requests and the activity log " +
              "for everyone. Export the data first if you need a copy."
            : "Your membership, your bookings and the related requests are removed. " +
              "Log entries assigned to you are deleted and remaining mentions of your name are anonymised.",
          confirmLabel: isOwner ? "Delete team for good" : "Delete data and leave",
          danger: true,
          onConfirm: async () => {
            const result = await run(() => api.deleteMyData());
            if (result) {
              toast(result.teamDeleted ? "Team deleted." : "Data deleted.");
              onSignedOut();
            }
          },
        }),
      }, icon("trash"), el("span", { text: isOwner ? "Delete team" : "Delete my data" })),
    ),
  );

  screen.append(
    el("div", { class: "section-title", text: "Legal" }),
    el("div", { class: "card list" },
      linkRow("Privacy policy", "/privacy"),
      linkRow("Legal notice", "/legal"),
      ...(instanceInfo?.operator
        ? [linkRow(`Questions? ${instanceInfo.operator.email}`, `mailto:${instanceInfo.operator.email}`)]
        : []),
      ...(isOwner ? [navRow("Who runs this copy", instanceInfo?.operator?.name ?? "", () => openOperatorEditor())] : []),
    ),
  );

  screen.append(
    el("p", { class: "tiny faint center" },
      `Studio Raum · Time zone ${snap.team.timeZone} · ` +
      `Updated ${formatTime(snap.fetchedAt, snap.team.timeZone)}`),
  );

  return screen;
}

function listRow(label: string, value: string): HTMLElement {
  return el("div", { class: "list-item" },
    el("span", { class: "grow", text: label }),
    el("span", { class: "small dim wrap", text: value }));
}

function navRow(label: string, value: string, onClick: () => void, badge?: string): HTMLElement {
  return el("button", { class: "list-item", onClick },
    el("span", { class: "grow", text: label }),
    badge ? el("span", { class: "pill", text: badge }) : null,
    value ? el("span", { class: "small dim", text: value }) : null,
    icon("chevron", "icon-sm"));
}

function linkRow(label: string, href: string): HTMLElement {
  return el("a", { class: "list-item", href },
    el("span", { class: "grow", text: label }),
    icon("chevron", "icon-sm"));
}

function toggleRow(label: string, hint: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  const input = el("input", { type: "checkbox", checked });
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "toggle-row" },
    el("div", { class: "grow" },
      el("div", { class: "small", text: label }),
      el("div", { class: "tiny faint wrap", text: hint })),
    input);
}

function notificationCard(refresh: Refresh): HTMLElement {
  const card = el("div", { class: "card stack" });
  const prefs = store.preferences();

  function render(subscribed: boolean, busy: boolean): void {
    const supported = pushSupported();
    const needsInstall = isAppleDevice() && !isInstalled();
    const denied = permissionState() === "denied";

    const children: Child[] = [
      toggleRow(
        "Receive notifications",
        "Requests for your rooms reach you on your phone.",
        prefs.notifyEnabled,
        async (value) => {
          await run(() => api.updatePreferences({ notifyEnabled: value }));
          await refresh();
        },
      ),
      toggleRow(
        "With vibration",
        "Without vibration the alert stays silent on the screen.",
        prefs.notifyVibrate,
        async (value) => {
          await run(() => api.updatePreferences({ notifyVibrate: value }));
          await refresh();
        },
      ),
      el("div", { class: "divider" }),
    ];

    if (store.pushPublicKey().length === 0) {
      children.push(
        el("div", { class: "banner" }, icon("warn"),
          el("span", { text: "No push key is set up for this service yet. " +
            "Alerts appear in the app." })),
      );
    } else if (needsInstall) {
      children.push(
        el("div", { class: "banner" }, icon("warn"),
          el("span", { text: "On the iPhone one step comes first: use Share, then Add to Home Screen, " +
            "and open Studio Raum from there." })),
      );
    } else if (!supported) {
      children.push(
        el("div", { class: "banner" }, icon("warn"),
          el("span", { text: "This browser does not support push messages. " +
            "Alerts still appear in the app." })),
      );
    } else if (denied) {
      children.push(
        el("div", { class: "banner banner-warn" }, icon("warn"),
          el("span", { text: "The browser has blocked notifications. " +
            "You can only allow them again in its settings." })),
      );
    } else if (subscribed) {
      children.push(
        el("div", { class: "row" }, icon("check", "icon-sm"),
          el("span", { class: "small", text: "This device is set up." })),
        el("button", {
          class: "btn btn-secondary btn-block", disabled: busy,
          onClick: async () => {
            const result = await run(() => api.sendTestNotification());
            if (result) {
              toast(result.devices > 0 ? "Test alert sent." : "No device registered.");
            }
            await refresh();
          },
        }, icon("bell"), el("span", { text: "Send a test alert" })),
        el("button", {
          class: "btn btn-quiet", disabled: busy,
          onClick: async () => {
            render(true, true);
            await disablePush();
            render(false, false);
            toast("Device removed.");
          },
        }, el("span", { text: "Remove this device" })),
      );
    } else {
      children.push(
        el("button", {
          class: "btn btn-primary btn-block", disabled: busy,
          onClick: async () => {
            render(false, true);
            const outcome = await enablePush(store.pushPublicKey());
            render(outcome === "ok", false);
            if (outcome === "ok") toast("Device set up.");
            else if (outcome === "denied") toast("The browser refused permission.", "error");
            else toast("Push could not be set up on this device.", "error");
            await refresh();
          },
        }, icon("bell"), el("span", { text: "Set up on this device" })),
        el("p", { class: "tiny faint" },
          "Setup is per device. Tap here once on every phone that " +
          "should get alerts."),
      );
    }

    card.replaceChildren(...children.filter((child): child is Node => child instanceof Node));
  }

  render(false, false);
  void (async () => render((await currentSubscription()) !== null, false))();
  return card;
}

function priorityCard(refresh: Refresh): HTMLElement {
  const card = el("div", { class: "card stack" });
  let order = store.studiosByPriority().map((studio) => studio.id);

  async function save(): Promise<void> {
    const done = await run(() => api.updatePreferences({ studioPriority: order }));
    if (done !== null) await refresh();
  }

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    order = next;
    render();
    void save();
  }

  function render(): void {
    card.replaceChildren(
      el("div", { class: "list" },
        ...order.map((id, index) =>
          el("div", { class: "list-item" },
            el("span", { class: "rank num", text: `${index + 1}` }),
            el("span", { class: "grow", text: store.studioName(id) }),
            el("button", {
              class: "btn btn-quiet", ariaLabel: "Move up", disabled: index === 0,
              onClick: () => move(index, -1),
            }, icon("up", "icon-sm")),
            el("button", {
              class: "btn btn-quiet", ariaLabel: "Move down", disabled: index === order.length - 1,
              onClick: () => move(index, 1),
            }, icon("down", "icon-sm")))),
      ),
      el("p", { class: "tiny faint" },
        "The room you would like most is at the top. A day request " +
        "asks in this order and holds the best free room for you."),
    );
  }

  render();
  return card;
}

function openStandingRules(refresh: Refresh): void {
  openSheet("Standing bookings", (handle) => {
    const studios = store.allStudios();
    const nodes: Child[] = [];

    for (const studio of studios) {
      const rules = store.standingRulesFor(studio.id);
      nodes.push(
        el("div", { class: "row-between" },
          el("div", { class: "section-title", text: studio.name }),
          el("button", {
            class: "btn btn-quiet",
            onClick: () => { handle.close(); openStandingEditor(null, studio.id, refresh); },
          }, icon("plus", "icon-sm"), el("span", { text: "Day" }))),
        rules.length === 0
          ? el("div", { class: "card" }, emptyState("No standing booking"))
          : el("div", { class: "card list" }, ...rules.map((rule) =>
              standingRow(rule, handle, refresh))),
      );
    }

    nodes.push(
      el("p", { class: "tiny faint" },
        "Each row puts a person on a weekday, eight weeks ahead. " +
        "Someone who cannot make a single day deletes their booking on that day; " +
        "the other days stay untouched."),
    );
    return nodes;
  });
}

function standingRow(rule: StandingRule, handle: { close(): void }, refresh: Refresh): HTMLElement {
  return el("button", {
    class: "list-item",
    onClick: () => { handle.close(); openStandingEditor(rule, rule.studioId, refresh); },
  },
    el("span", {
      class: isWeekendDay(rule.weekday) ? "weekday-chip weekday-weekend" : "weekday-chip",
      text: WEEKDAY_SHORT[rule.weekday] ?? "?",
    }),
    el("div", { class: "grow" },
      el("div", { class: "small", text: store.memberName(rule.memberUserId) }),
      el("div", { class: "tiny dim num", text: `${minuteLabel(rule.startMinute)} – ${minuteLabel(rule.endMinute)}` })),
    rule.isActive ? null : el("span", { class: "pill pill-muted", text: "Off" }),
    el("span", {
      class: `pill ${rule.state === "occupied" ? "pill-occupied" : "pill-reserved"}`,
      text: BOOKING_STATE_TITLE[rule.state],
    }),
    icon("chevron", "icon-sm"));
}

function minuteLabel(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${hour.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}

function minuteSelect(initial: number, kind: "start" | "end"): HTMLSelectElement {
  const select = el("select", { ariaLabel: kind === "start" ? "From" : "To" });
  const from = kind === "start" ? 0 : 30;
  const to = kind === "start" ? 1410 : 1440;
  for (let minute = from; minute <= to; minute += 30) {
    select.appendChild(el("option", { value: String(minute), text: minuteLabel(minute) }));
  }
  select.value = String(initial);
  return select;
}

function openStandingEditor(rule: StandingRule | null, studioId: string, refresh: Refresh): void {
  const studios = store.allStudios();
  const members = (store.snapshot().members ?? [])
    .filter((m) => m.isActive)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "en"));

  const studioSelect = el("select", { ariaLabel: "Studio" },
    ...studios.map((s) => el("option", { value: s.id, text: s.name })));
  studioSelect.value = rule?.studioId ?? studioId;

  const memberSelect = el("select", { ariaLabel: "Person" },
    ...members.map((m) => el("option", { value: m.userId, text: m.displayName })));
  memberSelect.value = rule?.memberUserId ?? store.currentUserId();

  const weekdaySelect = el("select", { ariaLabel: "Weekday" },
    ...[1, 2, 3, 4, 5, 6, 0].map((day) =>
      el("option", { value: String(day), text: WEEKDAY_TITLE[day] ?? "" })));
  weekdaySelect.value = String(rule?.weekday ?? 1);

  const startSelect = minuteSelect(rule?.startMinute ?? 0, "start");
  const endSelect = minuteSelect(rule?.endMinute ?? 1440, "end");

  const titleInput = el("input", {
    type: "text", maxLength: 500, placeholder: "e.g. Regular slot", value: rule?.title ?? "",
  });
  const activeToggle = el("input", { type: "checkbox", checked: rule?.isActive ?? true });

  let state: BookingState = rule?.state ?? "reserved";
  const stateHint = el("div", { class: "tiny faint" });
  const stateBox = el("div", { class: "stack" });
  function renderState() {
    stateHint.textContent = BOOKING_STATE_HINT[state];
    stateBox.replaceChildren(
      el("div", { class: "segmented" },
        ...(["reserved", "occupied"] as BookingState[]).map((value) =>
          el("button", {
            type: "button",
            class: ["segment", `segment-${value}`, state === value ? "segment-active" : ""]
              .filter(Boolean).join(" "),
            text: BOOKING_STATE_TITLE[value],
            onClick: () => { state = value; renderState(); },
          }))),
      stateHint,
    );
  }
  renderState();

  function draft(): StandingRuleInput {
    return {
      studioId: studioSelect.value,
      weekday: Number(weekdaySelect.value),
      memberUserId: memberSelect.value,
      startMinute: Number(startSelect.value),
      endMinute: Number(endSelect.value),
      state,
      title: titleInput.value,
      isActive: activeToggle.checked,
    };
  }

  openSheet(rule ? "Change standing booking" : "Add standing booking", (handle) => [
    field("Studio", studioSelect),
    field("Weekday", weekdaySelect),
    field("Person", memberSelect),
    el("div", { class: "field-row" },
      field("From", startSelect),
      field("To", endSelect)),
    field("Note (optional)", titleInput),
    el("div", { class: "field" },
      el("label", { text: "State" }),
      stateBox),
    el("label", { class: "row" }, activeToggle, el("span", { text: "Active" })),

    el("button", {
      class: "btn btn-primary btn-block",
      onClick: async () => {
        const done = await run(() => rule
          ? api.updateStandingRule(rule.id, draft())
          : api.createStandingRule(draft()));
        if (done !== null) {
          handle.close();
          await refresh();
          toast("Standing booking saved.");
        }
      },
    }, el("span", { text: "Save" })),

    rule
      ? el("button", {
          class: "btn btn-danger btn-block",
          onClick: () => {
            handle.close();
            confirmSheet({
              title: "Remove the standing booking?",
              message: "Upcoming dates of this series are released. Bookings that have " +
                "started or are in the past stay.",
              confirmLabel: "Remove",
              danger: true,
              onConfirm: async () => {
                const done = await run(() => api.deleteStandingRule(rule.id));
                await refresh();
                if (done !== null) toast("Standing booking removed.");
              },
            });
          },
        }, icon("trash"), el("span", { text: "Remove" }))
      : null,

    el("p", { class: "tiny faint" },
      "Two entries in the same room on the same weekday must not " +
      "overlap in time."),
  ]);
}

function openMembers(refresh: Refresh): void {
  openSheet("Members", (handle) => {
    const pending = store.pendingMembers();
    const active = (store.snapshot().members ?? [])
      .filter((m) => !m.isPending)
      .sort((a, b) => rank(b) - rank(a) || a.displayName.localeCompare(b.displayName, "en"));

    const nodes: Child[] = [];

    if (store.isManager() && pending.length > 0) {
      nodes.push(
        el("div", { class: "section-title", text: "Join requests" }),
        el("div", { class: "stack" }, ...pending.map((m) => pendingCard(m, handle, refresh))),
        el("p", { class: "tiny faint" },
          "These people joined with the join secret. " +
          "Until you approve them they cannot see or book anything."),
      );
    }

    const team = active.filter((m) => !m.isPlaceholder);
    const external = active.filter((m) => m.isPlaceholder);

    nodes.push(
      el("div", { class: "section-title", text: "Team" }),
      el("div", { class: "card list" }, ...team.map((m) => memberRow(m, handle, refresh))),
    );

    if (store.isManager() || external.length > 0) {
      nodes.push(
        el("div", { class: "section-title", text: "External people" }),
        external.length === 0
          ? el("div", { class: "empty", text: "None added yet." })
          : el("div", { class: "card list" }, ...external.map((m) => memberRow(m, handle, refresh))),
        el("p", { class: "tiny faint" },
          "For someone who holds a room but does not use the app. " +
          "They get a standing booking like everyone else but can never sign in. " +
          "An admin releases their days."),
      );
      if (store.isManager()) {
        nodes.push(el("button", {
          class: "btn btn-secondary btn-block",
          onClick: () => { handle.close(); openPlaceholderEditor(refresh); },
        }, icon("plus"), el("span", { text: "Add an external person" })));
      }
    }
    return nodes;
  });
}

function rank(member: TeamMember): number {
  return member.role === "owner" ? 3 : member.role === "admin" ? 2 : 1;
}

function memberRow(member: TeamMember, handle: { close(): void }, refresh: Refresh): HTMLElement {
  const status = memberStatus(member);
  const editable = store.isManager() && member.role !== "owner";

  const content = [
    icon(member.isPlaceholder ? "door" : "people"),
    el("div", { class: "grow" },
      el("div", { text: member.displayName }),
      el("div", { class: "tiny dim",
        text: member.isPlaceholder ? PLACEHOLDER_HINT : ROLE_TITLE[member.role] })),
    status !== "active"
      ? el("span", { class: "pill pill-muted", text: MEMBER_STATUS_TITLE[status] })
      : null,
    editable ? icon("chevron", "icon-sm") : null,
  ];

  return editable
    ? el("button", {
        class: "list-item",
        onClick: () => { handle.close(); openMemberEditor(member, refresh); },
      }, ...content)
    : el("div", { class: "list-item" }, ...content);
}

function pendingCard(member: TeamMember, handle: { close(): void }, refresh: Refresh): HTMLElement {
  const decide = async (approve: boolean) => {
    handle.close();
    const done = await run(() =>
      approve ? api.approveMember(member.userId) : api.rejectMember(member.userId));
    await refresh();
    if (done !== null) toast(approve ? `${member.displayName} approved.` : "Request declined.");
  };

  return el("div", { class: "card stack" },
    el("div", { class: "row" }, icon("people"),
      el("div", { class: "grow" },
        el("div", { text: member.displayName }),
        el("div", { class: "tiny dim", text: "Joined with the join secret" }))),
    el("div", { class: "row" },
      el("button", { class: "btn btn-danger", onClick: () => void decide(false) },
        el("span", { text: "Decline" })),
      el("span", { class: "spacer" }),
      el("button", { class: "btn btn-primary", onClick: () => void decide(true) },
        el("span", { text: "Approve" }))),
  );
}

function openMemberEditor(member: TeamMember, refresh: Refresh): void {
  const nameInput = el("input", { type: "text", value: member.displayName, maxLength: 100 });
  const roleSelect = el("select", { ariaLabel: "Role" },
    el("option", { value: "member", text: "Member" }),
    el("option", { value: "admin", text: "Admin" }));
  roleSelect.value = member.role === "owner" ? "admin" : member.role;

  const activeToggle = el("input", { type: "checkbox", checked: member.isActive });
  const writeToggle = el("input", { type: "checkbox", checked: true });

  const placeholder = member.isPlaceholder;

  openSheet(member.displayName, (handle) => [
    field("Name", nameInput),
    placeholder ? null : field("Role", roleSelect,
      "An admin may manage the bookings of all members, add studios, " +
      "maintain the standing bookings and approve members."),
    el("label", { class: "row" }, activeToggle,
      el("span", { text: placeholder ? "Still holds their room" : "Active in the team" })),
    placeholder ? null : el("label", { class: "row" }, writeToggle, el("span", { text: "May book" })),
    el("p", { class: "tiny faint" },
      placeholder
        ? "While this is off, the standing booking writes nothing more for this person."
        : "A block takes effect immediately: this person's sessions are ended."),
    el("button", {
      class: "btn btn-primary btn-block",
      onClick: async () => {
        const done = await run(() => api.updateMember(member.userId, {
          displayName: nameInput.value,
          role: roleSelect.value,
          isActive: activeToggle.checked,
          canWrite: writeToggle.checked,
        }));
        if (done !== null) {
          handle.close();
          await refresh();
          toast("Member updated.");
        }
      },
    }, el("span", { text: "Save" })),

    !placeholder ? null : el("button", {
      class: "btn btn-danger btn-block",
      onClick: () => confirmSheet({
        title: `Remove ${member.displayName}?`,
        message: "Their bookings and standing bookings are deleted. " +
          "Open requests on them are withdrawn.",
        confirmLabel: "Remove",
        danger: true,
        onConfirm: async () => {
          const done = await run(() => api.deletePlaceholderMember(member.userId));
          if (done !== null) {
            handle.close();
            await refresh();
            toast("External person removed.");
          }
        },
      }),
    }, icon("trash"), el("span", { text: "Remove external person" })),
  ]);
}

function openPlaceholderEditor(refresh: Refresh): void {
  const nameInput = el("input", {
    type: "text", maxLength: 100, placeholder: "e.g. Piano teacher",
  });

  openSheet("External person", (handle) => [
    field("Name", nameInput,
      "This is how they appear in the room plan. They get no secret and cannot sign in."),
    el("p", { class: "tiny faint" },
      "Afterwards you enter their regular days under Standing bookings."),
    el("button", {
      class: "btn btn-primary btn-block",
      onClick: async () => {
        const done = await run(() => api.createPlaceholderMember(nameInput.value));
        if (done !== null) {
          handle.close();
          await refresh();
          toast("External person added.");
        }
      },
    }, el("span", { text: "Add" })),
  ]);
}

function openJoinSettings(refresh: Refresh): void {
  const snap = store.snapshot();
  let selected: JoinMode = snap.team.joinMode;

  openSheet("Joining and secret", (handle) => {
    const optionList = el("div", { class: "card stack" });

    function renderOptions() {
      optionList.replaceChildren(
        el("div", { class: "section-title", text: "Who may join?" }),
        ...JOIN_MODES.map((option) =>
          el("button", {
            class: "list-item",
            onClick: async () => {
              selected = option.value;
              renderOptions();
              const done = await run(() =>
                api.updateTeam(snap.team.name, snap.team.timeZone, option.value));
              if (done !== null) { await refresh(); toast("Join mode changed."); }
            },
          },
            icon(selected === option.value ? "check" : "chevron", "icon-sm"),
            el("div", { class: "grow" },
              el("div", { text: option.title }),
              el("div", { class: "tiny dim", text: option.explanation })),
          )),
      );
    }
    renderOptions();

    return [
      optionList,
      el("div", { class: "card stack" },
        el("div", { class: "section-title", text: "Join secret" }),
        el("p", { class: "small dim" },
          "For security an existing secret is never shown again. " +
          "Generate a new one when you want to hand it on; the old one stops working at once."),
        el("button", {
          class: "btn btn-secondary btn-block",
          onClick: () => confirmSheet({
            title: "Generate a new join secret?",
            message: "The current secret stops working at once. Members who already " +
              "joined keep their access.",
            confirmLabel: "Generate",
            onConfirm: async () => {
              const result = await run(() => api.rotateJoinSecret());
              if (result) { handle.close(); showSecret("New join secret", result.joinSecret); }
            },
          }),
        }, icon("refresh"), el("span", { text: "Generate a new join secret" })),
      ),
    ];
  });
}

function showSecret(title: string, secret: string): void {
  openSheet(title, () => [
    el("div", { class: "banner banner-warn" }, icon("warn"),
      el("span", { text: "This secret is shown exactly once." })),
    el("div", { class: "secret", text: secret }),
    copyButton(secret, "Copy"),
  ]);
}

function openSecretRotation(): void {
  confirmSheet({
    title: "Renew your personal secret?",
    message: "Your current secret stops working at once and all your other " +
      "signed-in devices are signed out. Use this if your secret fell into the wrong hands.",
    confirmLabel: "Generate",
    onConfirm: async () => {
      const result = await run(() => api.rotatePersonalSecret());
      if (result) showSecret("New personal secret", result.personalSecret);
    },
  });
}

function openTeamEditor(refresh: Refresh): void {
  const snap = store.snapshot();
  const nameInput = el("input", { type: "text", value: snap.team.name, maxLength: 100 });
  const zoneSelect = el("select", { ariaLabel: "Time zone" });
  for (const zone of timeZoneOptions(snap.team.timeZone)) {
    zoneSelect.appendChild(el("option", { value: zone, text: zone }));
  }
  zoneSelect.value = snap.team.timeZone;

  openSheet("Edit team", (handle) => [
    field("Name", nameInput),
    field("Time zone", zoneSelect,
      "All times in the room plan use this zone. Existing bookings keep their point in time."),
    el("button", {
      class: "btn btn-primary btn-block",
      onClick: async () => {
        const done = await run(() =>
          api.updateTeam(nameInput.value, zoneSelect.value, snap.team.joinMode));
        if (done !== null) { handle.close(); await refresh(); toast("Team updated."); }
      },
    }, el("span", { text: "Save" })),
  ]);
}

function openStudios(refresh: Refresh): void {
  openSheet("Manage studios", (handle) => [
    el("div", { class: "card list" }, ...store.allStudios().map((studio) =>
      el("button", {
        class: "list-item",
        onClick: () => { handle.close(); openStudioEditor(studio, refresh); },
      },
        icon("door"),
        el("div", { class: "grow" },
          el("div", { text: studio.name }),
          studio.subtitle ? el("div", { class: "tiny dim", text: studio.subtitle }) : null),
        studio.isActive ? null : el("span", { class: "pill pill-muted", text: "Inactive" }),
        icon("chevron", "icon-sm")))),

    el("button", {
      class: "btn btn-primary btn-block",
      onClick: () => { handle.close(); openStudioEditor(null, refresh); },
    }, icon("plus"), el("span", { text: "Add a studio" })),

    el("p", { class: "tiny faint" },
      "A studio is never deleted, only set to inactive. That keeps " +
      "past bookings and the log complete."),
  ]);
}

function openStudioEditor(studio: Studio | null, refresh: Refresh): void {
  const nameInput = el("input", { type: "text", value: studio?.name ?? "", maxLength: 100,
    placeholder: "e.g. Studio D" });
  const subtitleInput = el("input", { type: "text", value: studio?.subtitle ?? "", maxLength: 200,
    placeholder: "e.g. Mixing" });
  const activeToggle = el("input", { type: "checkbox", checked: studio?.isActive ?? true });

  openSheet(studio ? "Edit studio" : "Add a studio", (handle) => [
    field("Name", nameInput),
    field("Subtitle (optional)", subtitleInput),
    studio ? el("label", { class: "row" }, activeToggle, el("span", { text: "Visible in the room plan" })) : null,
    el("button", {
      class: "btn btn-primary btn-block",
      onClick: async () => {
        const done = await run(() => studio
          ? api.updateStudio(studio.id, {
              name: nameInput.value, subtitle: subtitleInput.value,
              sortOrder: studio.sortOrder, isActive: activeToggle.checked,
            })
          : api.createStudio(nameInput.value, subtitleInput.value));
        if (done !== null) { handle.close(); await refresh(); toast("Studio saved."); }
      },
    }, el("span", { text: "Save" })),
  ]);
}

function openActivityLog(): void {
  const snap = store.snapshot();
  const zone = snap.team.timeZone;

  openSheet("Activity log", () => [
    snap.activities.length === 0
      ? emptyState("No entries yet")
      : el("div", { class: "card list" }, ...snap.activities.map((entry) =>
          el("div", { class: "list-item" },
            icon("clock", "icon-sm"),
            el("div", { class: "grow" },
              el("div", { class: "small wrap", text: entry.message }),
              el("div", { class: "tiny faint", text: `${formatDayTitle(entry.createdAt, zone)}, ${formatTime(entry.createdAt, zone)}` }))))),
    el("p", { class: "tiny faint" },
      "The log keeps the latest 500 entries. Older ones are removed automatically."),
  ]);
}

async function exportData(): Promise<void> {
  const data = await run(() => api.exportData());
  if (data === null) return;

  const teamName = store.snapshot().team.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 64);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url });
  link.download = `${teamName || "Studio-Raum"}-export.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("Export downloaded.");
}

// The owner's details shown in this copy's privacy policy and legal notice (worker/legal.ts).
function openOperatorEditor(): void {
  const current = instanceInfo?.operator;
  const nameInput = el("input", { type: "text", value: current?.name ?? "", maxLength: 100, autocomplete: "organization" });
  const emailInput = el("input", { type: "email", value: current?.email ?? "", maxLength: 200, autocomplete: "email" });
  const addressInput = el("textarea", { rows: "3", maxLength: 400, placeholder: "Street and number\nPostcode and town\nCountry" });
  addressInput.value = current?.address ?? "";
  const business = el("input", { type: "checkbox", checked: current?.business === true });

  openSheet("Who runs this copy", (handle) => [
    el("p", { class: "small dim",
      text: "These details appear in the privacy policy and legal notice of this copy." }),
    field("Name", nameInput),
    field("Email address", emailInput),
    el("label", { class: "row small" }, business,
      el("span", { text: "We use Studio Raum for our business or organisation" })),
    field("Postal address", addressInput, "Needed for business use."),
    el("button", {
      class: "btn btn-primary btn-block",
      onClick: async () => {
        const done = await run(() => api.updateOperator({
          operatorName: nameInput.value.trim(),
          operatorEmail: emailInput.value.trim(),
          operatorAddress: addressInput.value,
          operatorBusiness: business.checked,
        }));
        if (done) {
          await loadInstanceInfo();
          handle.close();
          toast("Saved. The privacy policy and legal notice show the new details.");
        }
      },
    }, el("span", { text: "Save" })),
  ]);
}
