import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { DEFAULT_SELF_EMAILS, markdownFileName, type AppContext } from "./context.js";
import type { CalendarAttendee, CalendarEvent } from "./ports.js";

/** Email domains of the user's own organisations; anyone else is an External person. A setting later (PRD Phase A). */
export const DEFAULT_INTERNAL_DOMAINS = ["eagleeye.com", "untienots.com"];
export { DEFAULT_SELF_EMAILS };
/** Personal mail providers: the domain names a mailbox, not an organisation. */
const FREE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.fr", "live.com", "live.fr", "msn.com", "yahoo.com", "yahoo.fr", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.fr", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "laposte.net"]);

/** How a Person's addresses are stored: `identifiers: [{ kind: email, value }]`, value lowercased. */
export type PersonIdentifier = { kind: "email"; value: string };

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

/** Email addresses recorded on a person; hand-edited files may list plain strings. */
export function personEmails(person: LifeOSObject) {
  const identifiers = Array.isArray(person.frontmatter.identifiers) ? person.frontmatter.identifiers as unknown[] : [];
  return identifiers.map((identifier) => typeof identifier === "string" ? normalizeEmail(identifier)
    : typeof identifier === "object" && identifier && (identifier as { kind?: unknown }).kind === "email" ? normalizeEmail((identifier as { value?: unknown }).value) : undefined)
    .filter((email): email is string => Boolean(email));
}

/** "jean-pierre" → "Jean-Pierre", "élodie" → "Élodie": title case per hyphen-separated part. */
function titleCase(word: string) {
  return word.split("-").map((part) => { const [first = "", ...rest] = Array.from(part); return first.toLocaleUpperCase() + rest.join("").toLocaleLowerCase(); }).join("-");
}

/**
 * Names for a new Person. The calendar display name wins; otherwise `first.last@` / `first_last@`
 * becomes "First Last" (accents and hyphens kept); a local part with no separator becomes the given name as is.
 */
export function derivePersonName(email: string, displayName?: string): { title: string; given_name: string; family_name?: string } {
  const display = displayName?.normalize("NFC").trim().replace(/\s+/g, " ");
  if (display && !display.includes("@")) {
    const [given, ...family] = display.split(" ");
    return family.length ? { title: display, given_name: given!, family_name: family.join(" ") } : { title: display, given_name: given! };
  }
  const local = email.trim().normalize("NFC").split("@")[0]!.replace(/\+.*$/, "");
  const parts = local.split(/[._]+/).filter(Boolean).map(titleCase);
  if (parts.length >= 2) return { title: parts.join(" "), given_name: parts[0]!, family_name: parts.slice(1).join(" ") };
  return { title: local || email, given_name: local || email };
}

/** "acme-corp.fr" → "Acme-Corp", "mail.acme.co.uk" → "Acme"; none for personal mail providers. */
export function organizationFromDomain(domain: string) {
  if (FREE_MAIL_DOMAINS.has(domain)) return undefined;
  const labels = domain.split(".");
  const secondLevel = labels.length >= 3 && ["co", "com", "org", "net", "ac", "gov"].includes(labels[labels.length - 2]!);
  const name = labels[labels.length - (secondLevel ? 3 : 2)];
  return name ? titleCase(name) : undefined;
}

/** One attendee as the matcher sees it. Name-only connectors give strings; a bare address counts as an email. */
function attendeesOf(event: CalendarEvent): CalendarAttendee[] {
  if (event.attendeeDetails) return event.attendeeDetails;
  return event.attendees.map((label) => normalizeEmail(label) ? { email: label } : { displayName: label });
}

/** People for calendar attendees (#38): matched by email, created when unknown, the user always the self person. */
export class PeopleModule {
  /** Serializes resolution so concurrent meetings sharing a new attendee agree on one person. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: AppContext) {}

  /** Read-only: the existing person, or an unsaved stand-in with the name a real one would get. */
  previewAttendees(event: CalendarEvent, synthetic: (title: string) => LifeOSObject) {
    const byEmail = this.peopleByEmail();
    const self = this.selfPerson();
    return attendeesOf(event).map((attendee) => {
      const email = normalizeEmail(attendee.email);
      const known = attendee.self || (email && DEFAULT_SELF_EMAILS.includes(email)) ? self : email ? byEmail.get(email) : undefined;
      return known ?? synthetic(email ? derivePersonName(email, attendee.displayName).title : attendee.displayName ?? "Unknown attendee");
    }).filter((person, index, all) => all.findIndex((other) => other.frontmatter.id === person.frontmatter.id) === index);
  }

  resolveAttendees(event: CalendarEvent, timestamp: string, ensureNamed: (name: string) => Promise<LifeOSObject>) {
    const run = this.queue.catch(() => undefined).then(() => this.resolveSerialized(event, timestamp, ensureNamed));
    this.queue = run;
    return run;
  }

  private async resolveSerialized(event: CalendarEvent, timestamp: string, ensureNamed: (name: string) => Promise<LifeOSObject>) {
    const { ctx } = this;
    const attendees = attendeesOf(event);
    let wrote = false;
    let self: LifeOSObject | undefined;
    if (attendees.some((attendee) => attendee.self || attendee.email)) {
      const before = this.selfPerson();
      self = await this.ensureSelfEmails(await ctx.ensureSelfPerson(timestamp), timestamp);
      wrote = self.contentHash !== before?.contentHash;
    }
    const byEmail = this.peopleByEmail();
    const people: LifeOSObject[] = [];
    for (const attendee of attendees) {
      const email = normalizeEmail(attendee.email);
      let person = attendee.self || (email && DEFAULT_SELF_EMAILS.includes(email)) ? self : email ? byEmail.get(email) : undefined;
      if (!person && email) {
        person = await this.createPerson(email, attendee.displayName, timestamp);
        byEmail.set(email, person);
        wrote = true;
      }
      // No usable email: the legacy match by name.
      if (!person && attendee.displayName?.trim()) person = await ensureNamed(attendee.displayName.trim());
      if (person && !people.some((existing) => existing.frontmatter.id === person!.frontmatter.id)) people.push(person);
    }
    // The next resolution (possibly for another meeting) must see the people just written.
    if (wrote) await ctx.rebuildIndex();
    return people;
  }

  private selfPerson() {
    return this.ctx.index.all().find((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true && !object.frontmatter.deleted_at);
  }

  /** Live people by lowercased email. The self person's addresses always point to it. */
  private peopleByEmail() {
    const byEmail = new Map<string, LifeOSObject>();
    for (const person of this.ctx.index.all()) {
      if (person.frontmatter.type !== "person" || person.frontmatter.deleted_at) continue;
      for (const email of personEmails(person)) if (!byEmail.has(email) || person.frontmatter.is_self === true) byEmail.set(email, person);
    }
    return byEmail;
  }

  private async ensureSelfEmails(self: LifeOSObject, timestamp: string) {
    const have = personEmails(self);
    const missing = DEFAULT_SELF_EMAILS.filter((email) => !have.includes(email));
    if (!missing.length) return self;
    const identifiers = [...(Array.isArray(self.frontmatter.identifiers) ? self.frontmatter.identifiers : []), ...missing.map((value): PersonIdentifier => ({ kind: "email", value }))];
    return this.ctx.update(self, { identifiers }, { expectedHash: self.contentHash, now: timestamp });
  }

  private createPerson(email: string, displayName: string | undefined, timestamp: string) {
    const id = uuidV7();
    const { title, ...names } = derivePersonName(email, displayName);
    const domain = email.split("@")[1]!;
    const organization = organizationFromDomain(domain);
    return this.ctx.objects.write({
      relativePath: `people/${markdownFileName(title, id, timestamp)}`,
      frontmatter: {
        ...this.ctx.envelope(id, "person", title, timestamp, "calendar"),
        ...names,
        identifiers: [{ kind: "email", value: email } satisfies PersonIdentifier],
        review_state: "unreviewed",
        is_external: !DEFAULT_INTERNAL_DOMAINS.includes(domain),
        ...(organization ? { organization_name: organization } : {})
      },
      body: `# ${title}\n`
    });
  }
}
