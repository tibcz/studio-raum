import { el, icon, replace, type Child } from "./dom";
import { ApiError } from "./api";

let toastTimer: number | undefined;

export function toast(message: string, kind: "info" | "error" = "info"): void {
  document.querySelector(".toast")?.remove();
  const node = el("div", { class: kind === "error" ? "toast toast-error" : "toast", text: message, role: "status" });
  document.body.appendChild(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), kind === "error" ? 5200 : 2800);
}

export function reportError(error: unknown): void {
  if (error instanceof ApiError && error.code === "demo") {
    toast(error.message, "info");
    return;
  }
  const message = error instanceof ApiError
    ? error.message
    : "Unexpected error. Please try again.";
  toast(message, "error");
}

let overlay: HTMLElement | null = null;

export function setBusy(busy: boolean): void {
  if (busy && !overlay) {
    overlay = el("div", { class: "loading-overlay", ariaLabel: "Loading", role: "status" },
      el("div", { class: "spinner" }));
    document.body.appendChild(overlay);
  } else if (!busy && overlay) {
    overlay.remove();
    overlay = null;
  }
}

export async function run<T>(action: () => Promise<T>): Promise<T | null> {
  setBusy(true);
  try {
    return await action();
  } catch (error) {
    reportError(error);
    return null;
  } finally {
    setBusy(false);
  }
}

export interface SheetHandle {
  close(): void;
  body: HTMLElement;
}

export function openSheet(title: string, build: (handle: SheetHandle) => Child[]): SheetHandle {
  const body = el("div", { class: "sheet-body" });
  const backdrop = el("div", { class: "sheet-backdrop", role: "dialog" });

  const handle: SheetHandle = {
    body,
    close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    },
  };

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") handle.close();
  }

  const sheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-bar" },
      el("span", { text: title }),
      el("button", { class: "btn btn-quiet", ariaLabel: "Close", onClick: () => handle.close() },
        icon("close")),
    ),
    body,
  );

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) handle.close();
  });

  replace(body, ...build(handle));
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
  document.body.classList.add("no-scroll");
  document.addEventListener("keydown", onKey);
  return handle;
}

export function confirmSheet(options: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}): void {
  openSheet(options.title, (handle) => [
    el("p", { class: "dim", text: options.message }),
    el("button", {
      class: options.danger ? "btn btn-danger btn-block" : "btn btn-primary btn-block",
      text: options.confirmLabel,
      onClick: async () => {
        handle.close();
        await options.onConfirm();
      },
    }),
    el("button", { class: "btn btn-secondary btn-block", text: "Cancel", onClick: () => handle.close() }),
  ]);
}

let fieldCounter = 0;

export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const id = `field-${++fieldCounter}`;
  input.id = id;
  const name = el("label", { text: label });
  name.htmlFor = id;
  const note = hint ? el("div", { class: "tiny faint", text: hint }) : null;
  if (note) {
    note.id = `${id}-hint`;
    input.setAttribute("aria-describedby", note.id);
  }
  return el("div", { class: "field" }, name, input, note);
}

export function copyButton(value: string, label = "Copy"): HTMLElement {
  const button = el("button", { class: "btn btn-secondary" }, icon("copy"), el("span", { text: label }));
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      replace(button, icon("check"), el("span", { text: "Copied" }));
      window.setTimeout(() => replace(button, icon("copy"), el("span", { text: label })), 1800);
    } catch {
      toast("Copying failed. Please select the text by hand.", "error");
    }
  });
  return button;
}

export function emptyState(message: string): HTMLElement {
  return el("div", { class: "empty", text: message });
}
