import { el, icon } from "../dom";
import { api, instanceInfo } from "../api";
import { copyButton, field, run, toast } from "../ui";
import { update, state } from "../state";
import { timeZoneOptions } from "../datetime";

type Mode = "signin" | "join" | "create";

let mode: Mode = "signin";

export function resetAuthMode(): void {
  mode = "signin";
}

export function authView(onSignedIn: () => Promise<void>): HTMLElement {
  const screen = el("div", { class: "screen" });

  // A fresh copy shows only the setup form; a copy with its team only sign-in and join.
  const setup = instanceInfo !== null && !instanceInfo.setUp;
  const modes: Mode[] = setup ? ["create"] : instanceInfo?.open ? ["signin", "join", "create"] : ["signin", "join"];
  if (!modes.includes(mode)) mode = modes[0]!;

  const hero = el("div", { class: "hero" },
    icon("door", "icon-lg"),
    el("h1", { text: "Studio Raum" }),
    el("p", { class: "dim", text: setup ? "Set up your copy of Studio Raum." : "The shared room plan for your studio." }),
  );

  const panel = el("div", { class: "card" });
  const switcher = el("div", { class: "tabs-inline", role: "tablist" });

  function renderSwitcher() {
    switcher.replaceChildren(
      ...modes.map((value) =>
        el("button", {
          class: mode === value ? "active" : "",
          text: { signin: "Sign in", join: "Join", create: "New team" }[value],
          onClick: () => { mode = value; renderSwitcher(); renderPanel(); },
        })),
    );
  }

  function renderPanel() {
    panel.replaceChildren(
      mode === "signin" ? loginForm(onSignedIn)
        : mode === "join" ? joinForm()
        : createForm(setup),
    );
  }

  renderSwitcher();
  renderPanel();
  if (modes.length < 2) switcher.hidden = true;

  screen.append(
    hero,
    el("div", { class: "stack" },
      switcher,
      panel,
      el("p", { class: "tiny faint center" },
        "Your access is a secret, not a password. Keep it like a key: " +
        "whoever holds it is you in Studio Raum."),
      el("p", { class: "tiny faint center legal-links" },
        el("a", { href: "/privacy", text: "Privacy" }),
        el("span", { text: " · " }),
        el("a", { href: "/legal", text: "Legal notice" })),
    ),
  );
  return screen;
}

function loginForm(onSignedIn: () => Promise<void>): HTMLElement {
  const input = el("input", {
    type: "text",
    class: "mono",
    placeholder: "SR1-XXXXXXXXXX-XXXXX-…",
    autocomplete: "off",
    maxLength: 80,
    ariaLabel: "Personal secret",
  });

  const submit = async (event: Event) => {
    event.preventDefault();
    const secret = input.value.trim();
    if (secret.length === 0) return;
    const done = await run(async () => {
      await api.login(secret);
      return true;
    });
    if (done) await onSignedIn();
  };

  return el("form", { class: "stack", onSubmit: submit as (e: SubmitEvent) => void },
    el("h2", { text: "Sign in with your personal secret" }),
    field("Personal secret", input,
      "Capital letters and hyphens do not matter."),
    el("button", { class: "btn btn-primary btn-block", type: "submit" }, el("span", { text: "Sign in" })),
  );
}

function joinForm(): HTMLElement {
  const secretInput = el("input", {
    type: "text", class: "mono", placeholder: "SRJ1-XXXXXXXXXX-XXXXX-…",
    autocomplete: "off", maxLength: 80, ariaLabel: "Join secret",
  });
  const nameInput = el("input", {
    type: "text", placeholder: "Your name", autocomplete: "name", maxLength: 100,
  });

  const submit = async (event: Event) => {
    event.preventDefault();
    const result = await run(() => api.join(secretInput.value.trim(), nameInput.value.trim()));
    if (result) {
      update({ screen: "secret", reveal: { personalSecret: result.personalSecret, status: result.status } });
    }
  };

  return el("form", { class: "stack", onSubmit: submit as (e: SubmitEvent) => void },
    el("h2", { text: "Join a team" }),
    field("Join secret", secretInput, "You get this from the owner of the team."),
    field("Your name", nameInput, "This is how the others see you in the room plan."),
    el("button", { class: "btn btn-primary btn-block", type: "submit" }, el("span", { text: "Join" })),
  );
}

function createForm(setup: boolean): HTMLElement {
  const passwordInput = el("input", {
    type: "password", autocomplete: "off", maxLength: 200, ariaLabel: "Setup password",
  });
  const teamInput = el("input", {
    type: "text", placeholder: "e.g. Linden Studios", maxLength: 100, autocomplete: "organization",
  });
  const nameInput = el("input", {
    type: "text", placeholder: "Your name", autocomplete: "name", maxLength: 100,
  });

  const guessed = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin";
  const zoneSelect = el("select", { ariaLabel: "Time zone" });
  for (const zone of timeZoneOptions(guessed)) {
    zoneSelect.appendChild(el("option", { value: zone, text: zone }));
  }
  zoneSelect.value = guessed;

  const operatorName = el("input", { type: "text", placeholder: "Your name or your studio's name", maxLength: 100, autocomplete: "organization" });
  const operatorEmail = el("input", { type: "email", placeholder: "you@example.com", maxLength: 200, autocomplete: "email" });
  const operatorAddress = el("textarea", { rows: "3", placeholder: "Street and number\nPostcode and town\nCountry", maxLength: 400 });
  const business = el("input", { type: "checkbox" });

  const submit = async (event: Event) => {
    event.preventDefault();
    const result = await run(() =>
      api.createTeam(
        teamInput.value.trim(), nameInput.value.trim(), zoneSelect.value, passwordInput.value,
        setup
          ? {
              operatorName: operatorName.value.trim() || teamInput.value.trim(),
              operatorEmail: operatorEmail.value.trim(),
              operatorAddress: operatorAddress.value,
              operatorBusiness: business.checked,
            }
          : null,
      ));
    if (result) {
      update({
        screen: "secret",
        reveal: { personalSecret: result.personalSecret, joinSecret: result.joinSecret, status: "active" },
      });
    }
  };

  return el("form", { class: "stack", onSubmit: submit as (e: SubmitEvent) => void },
    el("h2", { text: setup ? "Set up Studio Raum" : "Create a new team" }),
    field("Setup password", passwordInput,
      "The password you chose in Cloudflare when you deployed Studio Raum."),
    field("Team name", teamInput),
    field("Your name", nameInput, "This is how the others see you in the room plan."),
    field("Time zone", zoneSelect,
      "All times in the room plan use this zone, wherever someone is right now."),
    ...(setup
      ? [
          el("h2", { text: "Who runs this copy" }),
          el("p", { class: "small dim",
            text: "These details appear in the privacy policy and legal notice of your copy, because you are "
              + "the one responsible for it. You can change them later under Settings." }),
          field("Name", operatorName, "Your name or your studio's name."),
          field("Email address", operatorEmail, "Where your team can reach you about their data."),
          el("label", { class: "row small" }, business,
            el("span", { text: "We use Studio Raum for our business or organisation" })),
          field("Postal address", operatorAddress,
            "Needed for business use: the legal notice has to name an address where you can be reached."),
        ]
      : []),
    el("button", { class: "btn btn-primary btn-block", type: "submit" },
      el("span", { text: setup ? "Set up and create team" : "Create team" })),
  );
}

export function secretView(onContinue: () => Promise<void>): HTMLElement {
  const reveal = state.reveal;
  if (!reveal) return el("div");

  const acknowledged = el("input", { type: "checkbox" });
  const continueButton = el("button", {
    class: "btn btn-primary btn-block", disabled: true,
    onClick: async () => { update({ reveal: null }); await onContinue(); },
  }, el("span", { text: "Continue" }));

  acknowledged.addEventListener("change", () => {
    continueButton.toggleAttribute("disabled", !acknowledged.checked);
  });

  return el("div", { class: "screen" },
    el("div", { class: "hero" },
      icon("key", "icon-lg"),
      el("h1", { text: "Your personal secret" }),
    ),
    el("div", { class: "stack" },
      el("div", { class: "banner banner-warn" }, icon("warn"),
        el("span", { text: "This secret is shown exactly once. It cannot be recovered." })),

      el("div", { class: "card stack" },
        el("div", { class: "section-title", text: "Personal secret" }),
        el("div", { class: "secret", text: reveal.personalSecret }),
        copyButton(reveal.personalSecret, "Copy secret"),
        el("p", { class: "small dim" },
          "You use it to sign in from now on. Save it in your password manager. " +
          "Do not give it to anyone: whoever has it can book in your name."),
      ),

      reveal.joinSecret
        ? el("div", { class: "card stack" },
            el("div", { class: "section-title", text: "Join secret of the team" }),
            el("div", { class: "secret", text: reveal.joinSecret }),
            copyButton(reveal.joinSecret, "Copy join secret"),
            el("p", { class: "small dim" },
              "Hand this to everyone who should take part. They land in the join " +
              "requests first and can only book after you approve them. " +
              "You can find it again in Settings at any time."),
          )
        : null,

      reveal.status === "pending"
        ? el("div", { class: "banner" }, icon("clock"),
            el("span", { text: "An admin still has to approve you before you can book." }))
        : null,

      el("label", { class: "row" },
        acknowledged,
        el("span", { class: "small", text: "I have saved the secret safely." })),
      continueButton,
    ),
  );
}

export function pendingView(onCheck: () => Promise<void>): HTMLElement {
  return el("div", { class: "screen" },
    el("div", { class: "hero" },
      icon("clock", "icon-lg"),
      el("h1", { text: "Almost there" }),
      el("p", { class: "dim" },
        "You joined with the join secret. An admin still has to approve " +
        "you before you can book."),
    ),
    el("div", { class: "stack" },
      el("button", { class: "btn btn-primary btn-block", onClick: () => void onCheck() },
        icon("refresh"), el("span", { text: "Check status" })),
      el("button", {
        class: "btn btn-secondary btn-block",
        onClick: async () => {
          await run(() => api.logout());
          toast("Signed out.");
          update({ screen: "signin", snapshot: null });
        },
      }, el("span", { text: "Sign out" })),
    ),
  );
}
