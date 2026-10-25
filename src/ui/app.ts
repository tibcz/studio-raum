import { el, icon, replace } from "./dom";
import { ApiError, DEMO, api, loadInstanceInfo } from "./api";
import { reportError, toast } from "./ui";
import * as store from "./state";
import { authView, pendingView, resetAuthMode, secretView } from "./views/auth";
import { planTopBar, planView } from "./views/plan";
import { calendarTopBar, calendarView } from "./views/calendar";
import { myBookingsView } from "./views/mybookings";
import { settingsView } from "./views/settings";
import { registerWorker } from "./push";
import { demoStrip, demoView } from "../demo/view";

const root = document.getElementById("app")!;
let socket: WebSocket | null = null;
let reconnectDelay = 1000;

async function loadSnapshot(): Promise<void> {
  try {
    const snapshot = await api.snapshot();
    store.update({
      snapshot,
      screen: "app",
      selectedDay: store.state.snapshot === null
        ? store.today()
        : store.state.selectedDay,
    });
    connectLive();
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "notAuthenticated" || error.code === "invalidSecret") {
        store.update({ screen: "signin", snapshot: null });
        return;
      }
      if (error.code === "memberPending") {
        store.update({ screen: "waiting", snapshot: null });
        return;
      }
      if (error.code === "memberDisabled") {
        store.update({ screen: "signin", snapshot: null });
        toast(error.message, "error");
        return;
      }
    }
    store.update({ screen: "signin", snapshot: null });
    reportError(error);
  }
}

async function refresh(): Promise<void> {
  try {
    store.update({ snapshot: await api.snapshot() });
  } catch (error) {
    if (error instanceof ApiError && error.code === "notAuthenticated") {
      store.update({ screen: "signin", snapshot: null });
      return;
    }
    reportError(error);
  }
}

function connectLive(): void {
  if (DEMO) return;
  if (socket !== null && socket.readyState <= WebSocket.OPEN) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    socket = new WebSocket(`${protocol}//${location.host}/api/events`);
  } catch {
    return;
  }

  socket.addEventListener("open", () => { reconnectDelay = 1000; });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === "changed") void refresh();
      if (payload?.type === "deleted") store.update({ screen: "signin", snapshot: null });
    } catch {
    }
  });
  socket.addEventListener("close", () => {
    socket = null;
    if (store.state.screen !== "app") return;
    window.setTimeout(connectLive, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
}

let lastView = "";

function render(): void {
  const { screen, tab } = store.state;

  const view = `${screen}:${tab}`;
  if (view !== lastView) {
    lastView = view;
    window.scrollTo(0, 0);
  }

  if (screen === "loading") {
    replace(root, el("div", { class: "loading-overlay" }, el("div", { class: "spinner" })));
    return;
  }
  if (screen === "signin") {
    replace(root, authView(loadSnapshot));
    return;
  }
  if (screen === "secret") {
    replace(root, secretView(loadSnapshot));
    return;
  }
  if (screen === "waiting") {
    replace(root, pendingView(loadSnapshot));
    return;
  }

  const body =
    tab === "plan" ? planView(refresh)
    : tab === "calendar" ? calendarView(refresh)
    : tab === "bookings" ? myBookingsView(refresh)
    : DEMO ? demoView(refresh)
    : settingsView(refresh, signOut);

  const top =
    tab === "plan" ? planTopBar(refresh)
    : tab === "calendar" ? calendarTopBar(refresh)
    : el("div", { class: "topbar" });

  if (DEMO) top.prepend(demoStrip());
  replace(root, top, body, tabBar());
}

function tabBar(): HTMLElement {
  const entry = (
    id: store.Tab, label: string, name: "plan" | "grid" | "calendar" | "settings",
    badge = 0, unread = false,
  ) =>
    el("button", {
      class: store.state.tab === id ? "tab tab-active" : "tab",
      onClick: () => store.update({ tab: id }),
    },
      el("span", { class: "tab-icon" },
        icon(name),
        unread ? el("span", { class: "tab-dot", ariaLabel: "New notifications" }) : null),
      el("span", { text: badge > 0 ? `${label} (${badge})` : label }));

  return el("nav", { class: "tabbar", ariaLabel: "Sections" },
    entry("plan", "Room plan", "plan"),
    entry("calendar", "Calendar", "grid"),
    entry("bookings", "Bookings", "calendar",
      store.incomingRequests().length, store.unreadNotifications().length > 0),
    DEMO
      ? entry("settings", "Your own", "settings")
      : entry("settings", "Settings", "settings",
        store.isManager() ? store.pendingMembers().length : 0),
  );
}

function signOut(): void {
  socket?.close();
  socket = null;
  resetAuthMode();
  store.update({ screen: "signin", snapshot: null, tab: "plan" });
  void loadInstanceInfo().then(() => store.update({}));
}

store.subscribe(render);
render();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && store.state.screen === "app") {
    void refresh();
    connectLive();
  }
});

if (!DEMO) {
  window.setInterval(() => {
    if (store.state.screen === "waiting") void loadSnapshot();
  }, 20_000);
}

void registerWorker();

void loadInstanceInfo().then(loadSnapshot);
