// Privacy policy (/privacy) and legal notice (/legal) of a self-hosted copy. They are rendered from
// the details the operator entered during setup, so every copy names its own operator. German is
// binding; the English translation follows on the same page.
import type { Operator } from "./do/instance";

type Lang = "de" | "en";
type Text = Record<Lang, string>;

const esc = (text: string) => text
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const block = (text: string) => esc(text).replaceAll("\n", "<br>");

function page(title: Text, sections: Array<[Text, Text[]]>, updated: string): string {
  const article = (lang: Lang) => `<article lang="${lang}" id="${lang}">
<h1>${esc(title[lang])}</h1>
<p class="meta">${lang === "de" ? `Stand: ${updated} · Verbindliche Fassung` : `Last updated: ${updated} · English translation for convenience. Only the German version is binding.`}</p>
${sections.map(([heading, paragraphs]) => `<section>
<h2>${esc(heading[lang])}</h2>
${paragraphs.map((p) => `<p>${block(p[lang])}</p>`).join("\n")}
</section>`).join("\n")}
</article>`;
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title.de)} / ${esc(title.en)} - Studio Raum</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/legal.css">
</head>
<body>
<header class="bar"><a class="mark" href="/">Studio Raum</a>
<nav class="lang" aria-label="Language / Sprache"><a href="#de" hreflang="de">Deutsch</a> <a href="#en" hreflang="en">English</a></nav></header>
<main>
${article("de")}
${article("en")}
</main>
<footer class="foot"><a href="/">Studio Raum</a> <a href="/privacy">Privacy Policy</a> <a href="/legal">Legal notice</a></footer>
</body>
</html>
`;
}

function contactLines(operator: Operator): string {
  return [operator.name, operator.address, operator.email].filter((line) => line.trim().length > 0).join("\n");
}

const notSetUp = (): string => page(
  { de: "Noch nicht eingerichtet", en: "Not set up yet" },
  [[
    { de: "Diese Kopie von Studio Raum", en: "This copy of Studio Raum" },
    [{
      de: "Diese Kopie von Studio Raum ist noch nicht eingerichtet. Sobald ihr Betreiber sie einrichtet, stehen hier seine Angaben.",
      en: "This copy of Studio Raum has not been set up yet. Once its operator sets it up, their details appear here.",
    }],
  ]],
  "-",
);

export function legalNoticePage(operator: Operator | null, updated: string): string {
  if (operator === null) return notSetUp();
  const lines = contactLines(operator);
  return page(
    { de: "Impressum", en: "Legal notice" },
    [
      [
        { de: operator.business ? "Angaben gemäß § 5 DDG" : "Betreiber", en: operator.business ? "Information under Section 5 DDG" : "Operator" },
        [{ de: lines, en: lines }],
      ],
      [
        { de: "Kontakt und Meldungen", en: "Contact and reports" },
        [{
          de: `Fragen zu dieser Kopie von Studio Raum, zu Ihren Daten oder Hinweise auf rechtswidrige Inhalte richten Sie bitte per E-Mail an ${operator.email}.`,
          en: `Please send questions about this copy of Studio Raum, about your data, or reports of illegal content by email to ${operator.email}.`,
        }],
      ],
      [
        { de: "Software", en: "Software" },
        [{
          de: "Diese Kopie wird von der oben genannten Person oder Organisation betrieben. Die Software Studio Raum ist quelloffen (MIT-Lizenz, github.com/tibcz/studio-raum). Ihr Entwickler betreibt diese Kopie nicht und hat keinen Zugriff auf ihre Daten.",
          en: "This copy is run by the person or organisation named above. The Studio Raum software is open source (MIT licence, github.com/tibcz/studio-raum). Its developer does not run this copy and has no access to its data.",
        }],
      ],
    ],
    updated,
  );
}

export function privacyPage(operator: Operator | null, updated: string): string {
  if (operator === null) return notSetUp();
  const lines = contactLines(operator);
  const email = operator.email;
  const p = (de: string, en: string): Text => ({ de, en });
  return page(
    { de: "Datenschutzerklärung", en: "Privacy policy" },
    [
      [p("Verantwortlicher", "Controller"), [
        p(`Verantwortlich im Sinne der Datenschutz-Grundverordnung (DSGVO) für diese Kopie von Studio Raum ist:\n${lines}`,
          `The controller for this copy of Studio Raum within the meaning of the General Data Protection Regulation (GDPR) is:\n${lines}`),
      ]],
      [p("Überblick", "Overview"), [
        p("Studio Raum ist ein gemeinsamer Raumplan für ein Team. Mitglieder buchen Räume, tragen feste Wochentage ein, fragen Zeiträume an und geben Tage frei. Es gibt keine Werbung und keine Analyse- oder Tracking-Dienste. Die Teamdaten liegen auf dem Cloudflare-Konto des Verantwortlichen; der Entwickler der Software hat keinen Zugriff darauf.",
          "Studio Raum is a shared room plan for a team. Members book rooms, enter fixed weekdays, request time ranges and release days. There is no advertising and no analytics or tracking service. The team data sits in the controller's Cloudflare account; the developer of the software has no access to it."),
      ]],
      [p("Zugang ohne Konto", "Access without an account"), [
        p("Es gibt keine Anmeldung mit E-Mail-Adresse und Passwort. Jede Person weist sich mit einem persönlichen Geheimnis aus, einer langen Zufallsfolge. Einem Team tritt man mit einem Beitrittsgeheimnis bei. Beide werden nie im Klartext gespeichert, sondern nur als HMAC-SHA-256 mit einem geheimen Schlüssel.",
          "There is no sign-in with an email address and password. Each person identifies with a personal secret, a long random string. A team is joined with a join secret. Neither is ever stored in plain text, only as HMAC-SHA-256 with a secret key."),
      ]],
      [p("Verarbeitete Daten", "Data processed"), [
        p("Gespeichert werden: Anzeigename, Rolle und Status jedes Mitglieds; die Hashwerte der Geheimnisse und Sitzungen mit ihren Zeitpunkten; Name, Zeitzone und Beitrittsmodus des Teams; Räume; Buchungen mit Raum, Zeitraum, optionaler Notiz, Zustand und Person; feste Belegungen; Anfragen; ein Aktivitätsverlauf (nur für Admins sichtbar, höchstens 500 Einträge); Benachrichtigungen in der App (höchstens 50 je Person); Einstellungen; und, wenn Sie Push-Benachrichtigungen einschalten, die Adresse beim Push-Dienst Ihres Browsers mit zwei öffentlichen Schlüsseln.",
          "Stored are: display name, role and status of each member; the hashes of the secrets and sessions with their times; the team's name, time zone and join mode; rooms; bookings with room, time range, optional note, state and person; standing bookings; requests; an activity log (visible to admins only, at most 500 entries); in-app notifications (at most 50 per person); settings; and, if you turn on push notifications, the address at your browser's push service with two public keys."),
        p("Alle aktiven Mitglieder sehen Räume, Buchungen mit Anzeigenamen und Notizen, Anfragen und feste Belegungen. Bitte tragen Sie in Notizen keine besonderen Kategorien personenbezogener Daten ein.",
          "All active members see rooms, bookings with display names and notes, requests and standing bookings. Please do not put special categories of personal data into notes."),
      ]],
      [p("Rechtsgrundlagen", "Legal bases"), [
        p("Die Verarbeitung ist zur Bereitstellung des Raumplans erforderlich (Art. 6 Abs. 1 lit. b DSGVO; bei Beschäftigten § 26 BDSG bzw. Art. 88 DSGVO). Missbrauchsschutz und Aktivitätsverlauf beruhen auf dem berechtigten Interesse an einem sicheren und nachvollziehbaren Raumplan (Art. 6 Abs. 1 lit. f DSGVO). Push-Benachrichtigungen beruhen auf Ihrer Einwilligung (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG).",
          "Processing is necessary to provide the room plan (Art. 6 (1) (b) GDPR; for employees Section 26 BDSG or Art. 88 GDPR). Abuse protection and the activity log rest on the legitimate interest in a secure and traceable room plan (Art. 6 (1) (f) GDPR). Push notifications rest on your consent (Art. 6 (1) (a) GDPR, Section 25 (1) TDDDG)."),
      ]],
      [p("Cookie, Speicherung im Browser und Missbrauchsschutz", "Cookie, browser storage and abuse protection"), [
        p("Die App setzt genau ein Cookie (__Host-sr_session) mit der Sitzung. Es ist unbedingt erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG) und läuft nach 30 Tagen ohne Nutzung ab, spätestens nach 90 Tagen. Ein Service Worker hält die Dateien der App für den Offline-Start bereit. Fehlversuche bei Anmeldung und Beitritt werden gezählt; die IP-Adresse geht dabei nur als Hashwert ein und wird nach höchstens 15 Minuten gelöscht.",
          "The app sets exactly one cookie (__Host-sr_session) holding the session. It is strictly necessary (Section 25 (2) No. 2 TDDDG) and expires after 30 days without use, after 90 days at the latest. A service worker keeps the app's files ready for offline start. Failed sign-in and join attempts are counted; the IP address enters only as a hash and is deleted after 15 minutes at most."),
      ]],
      [p("Hosting bei Cloudflare", "Hosting with Cloudflare"), [
        p("Die App läuft auf Cloudflare Workers der Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA, als Auftragsverarbeiter (Art. 28 DSGVO; der Vertrag ist Teil der Bedingungen von Cloudflare). Cloudflare verarbeitet die Verbindungsdaten (IP-Adresse, Zeitpunkt, Adresse, Browser) zur Auslieferung und zur Abwehr von Angriffen (Art. 6 Abs. 1 lit. f DSGVO). Eine Verarbeitung in den USA ist möglich; Cloudflare ist unter dem EU-U.S. Data Privacy Framework zertifiziert (Art. 45 DSGVO).",
          "The app runs on Cloudflare Workers of Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA, as a processor (Art. 28 GDPR; the agreement is part of Cloudflare's terms). Cloudflare processes connection data (IP address, time, address, browser) to deliver the app and defend against attacks (Art. 6 (1) (f) GDPR). Processing in the USA is possible; Cloudflare is certified under the EU-U.S. Data Privacy Framework (Art. 45 GDPR)."),
      ]],
      [p("Push-Benachrichtigungen", "Push notifications"), [
        p("Schalten Sie Benachrichtigungen ein, gehen sie verschlüsselt (RFC 8291) an den Push-Dienst Ihres Browsers, je nach Gerät Google, Apple oder Mozilla in den USA. Der Dienst erhält die Adresse Ihres Geräts und den Zeitpunkt, kann den Inhalt aber nicht lesen. Google LLC und Apple Inc. sind unter dem EU-U.S. Data Privacy Framework zertifiziert; im Übrigen stützt sich die Übermittlung auf Ihre Einwilligung (Art. 49 Abs. 1 lit. a DSGVO). Sie können die Erlaubnis jederzeit im Browser widerrufen.",
          "If you turn on notifications, they go encrypted (RFC 8291) to your browser's push service, Google, Apple or Mozilla in the USA depending on the device. The service receives your device's address and the time but cannot read the content. Google LLC and Apple Inc. are certified under the EU-U.S. Data Privacy Framework; otherwise the transfer relies on your consent (Art. 49 (1) (a) GDPR). You can withdraw the permission in your browser at any time."),
      ]],
      [p("Automatische Raumzuteilung", "Automatic room allocation"), [
        p("Feste Belegungen schreiben Buchungen acht Wochen im Voraus, und eine Tagesanfrage rückt automatisch in einen frei gewordenen Raum ein. Das hat keine rechtliche oder ähnlich erhebliche Wirkung im Sinne von Art. 22 DSGVO; jede so entstandene Buchung lässt sich ändern oder löschen.",
          "Standing bookings write bookings eight weeks ahead, and a day request moves automatically into a room that comes free. This has no legal or similarly significant effect under Art. 22 GDPR; every booking made this way can be changed or deleted."),
      ]],
      [p("Speicherdauer, Export und Löschung", "Retention, export and deletion"), [
        p("Die Daten bleiben, solange das Team besteht. Unter Einstellungen > Daten können Sie jederzeit eine Kopie exportieren und Ihre Daten löschen; als Besitzer löschen Sie das ganze Team.",
          "The data stays as long as the team exists. Under Settings > Data you can export a copy and delete your data at any time; as owner you delete the whole team."),
      ]],
      [p("Ihre Rechte", "Your rights"), [
        p(`Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch gegen Verarbeitungen auf Grundlage berechtigter Interessen (Art. 21). Eine Einwilligung können Sie jederzeit mit Wirkung für die Zukunft widerrufen (Art. 7 Abs. 3). Schreiben Sie dafür an ${email}. Sie können sich außerdem bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO).`,
          `You have the right of access (Art. 15 GDPR), rectification (Art. 16), erasure (Art. 17), restriction (Art. 18), data portability (Art. 20) and to object to processing based on legitimate interests (Art. 21). You can withdraw consent at any time with effect for the future (Art. 7 (3)). Write to ${email} for this. You may also lodge a complaint with a data protection supervisory authority (Art. 77 GDPR).`),
        p("Sie sind nicht verpflichtet, Daten anzugeben; ohne Anzeigenamen kann die App Sie aber keinem Team zuordnen.",
          "You are not obliged to provide data; without a display name, however, the app cannot place you in a team."),
      ]],
    ],
    updated,
  );
}
