import { el, icon } from "../ui/dom";
import { newDemoTeam } from "../ui/api";
import * as store from "../ui/state";

export const REPO_URL = "https://github.com/tibcz/studio-raum";

export function demoStrip(): HTMLElement {
  return el("a", { class: "demo-strip", href: "/build" },
    el("span", { text: "Demo with a made-up studio. Nothing is saved." }),
    el("span", { class: "demo-strip-cta", text: "Build your own" }),
    icon("arrow"));
}

export function demoView(reload: () => Promise<void>): HTMLElement {
  const snap = store.snapshot();
  const screen = el("div", { class: "screen stack" });

  screen.append(
    el("h1", { text: "Build your own" }),
    el("div", { class: "card stack" },
      el("p", {},
        `You are looking at ${snap.team.name}, a studio that does not exist. `
        + "Its rooms, people and bookings were made up in your browser a moment ago. "
        + "Nothing you tap here is sent anywhere or saved."),
      el("button", {
        class: "btn btn-secondary btn-block",
        onClick: async () => {
          newDemoTeam();
          await reload();
        },
      }, icon("refresh"), el("span", { text: "Show another studio" })),
    ),
    el("div", { class: "section-title", text: "Your own Studio Raum" }),
    el("div", { class: "card stack" },
      el("p", {},
        "Studio Raum is free and open source. You run your own copy on your own Cloudflare account, "
        + "so your team's plan belongs to you and nobody else, me included."),
      el("ol", { class: "demo-steps" },
        el("li", { text: "Make a free GitHub account and a free Cloudflare account." }),
        el("li", { text: "Press the Deploy button and follow Cloudflare's steps." }),
        el("li", { text: "Open your new address and create your team." }),
      ),
      el("p", { class: "small dim", text: "About 15 minutes. No programming, no terminal, no cost on the free plans." }),
      el("a", { class: "btn btn-primary btn-block", href: "/build" },
        el("span", { text: "Show me how, step by step" }), icon("arrow")),
      el("a", { class: "btn btn-secondary btn-block", href: REPO_URL },
        el("span", { text: "Source code on GitHub" })),
    ),
    el("div", { class: "section-title", text: "About" }),
    el("div", { class: "card list" },
      link("Privacy Policy", "/privacy"),
      link("Terms of use", "https://tbor.app/terms"),
      link("Impressum", "https://tbor.app/impressum"),
    ),
  );
  return screen;
}

function link(label: string, href: string): HTMLElement {
  return el("a", { class: "list-item", href },
    el("span", { class: "grow", text: label }),
    icon("chevron", "icon-sm"));
}
