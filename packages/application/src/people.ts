import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { isUnreviewedPerson } from "@lifeos/shared";
import { markdownFileName, type AppContext } from "./context.js";
import type { CalendarAttendee, CalendarEvent } from "./ports.js";
import { byIdentifier, isLive, OneAtATime } from "./support.js";
import { SyncedSetting, type SyncedSettingSpec } from "./synced-settings.js";

/** The synced internal-domains setting (ADR 0005): one fixed file. Unset means nobody is External by email (#54). */
const internalDomainsKey = "internal-domains";
/** The synced self-email setting (#54): every address of the user, all resolving to the single self person (PRD story 73). Unset means none. */
const selfEmailsKey = "self-emails";
/** Appended to an External person's label. The words are always there, so red styling is never the only signal. */
export const EXTERNAL_SUFFIX = " - ext";
/** Personal mail providers: the domain names a mailbox, not an organisation. */
const FREE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.fr", "live.com", "live.fr", "msn.com", "yahoo.com", "yahoo.fr", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.fr", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "laposte.net"]);

/** How a Person's addresses are stored: `identifiers: [{ kind: email, value }]`, value lowercased. */
export type PersonIdentifier = { kind: "email"; value: string };

/** #214: the address already belongs to another person, who is named so the UI can offer a merge instead. */
export class PersonEmailTakenError extends Error {
  override name = "PersonEmailTakenError";
  constructor(readonly email: string, readonly otherPersonId: string, readonly otherPersonName: string) { super(`${email} belongs to ${otherPersonName}`); }
}

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

/**
 * The email address a name holds instead of a real name: "jane@example.com" or "Jane Doe <jane@example.com>".
 * A Person is never named by an address alone; callers store the address as its email instead.
 */
export function addressInName(text: unknown): { email: string; displayName?: string } | undefined {
  if (typeof text !== "string") return undefined;
  const angled = text.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = normalizeEmail(angled ? angled[2] : text);
  const displayName = angled?.[1]?.trim();
  return email ? { email, ...(displayName ? { displayName } : {}) } : undefined;
}

/** The address in one stored identifier; hand-edited files may list plain strings. */
function identifierEmail(identifier: unknown) {
  if (typeof identifier === "string") return normalizeEmail(identifier);
  return typeof identifier === "object" && identifier && (identifier as { kind?: unknown }).kind === "email" ? normalizeEmail((identifier as { value?: unknown }).value) : undefined;
}

/** Email addresses recorded on a person. */
export function personEmails(person: LifeOSObject) {
  const identifiers = Array.isArray(person.frontmatter.identifiers) ? person.frontmatter.identifiers as unknown[] : [];
  return identifiers.map(identifierEmail).filter((email): email is string => Boolean(email));
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

/** "  @Example.com. " → "example.com"; undefined when it is not a plausible domain name. */
export function normalizeDomain(value: unknown) {
  if (typeof value !== "string") return undefined;
  const domain = value.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(domain) ? domain : undefined;
}

/** Domains stored in a setting file; hand edits may leave junk, which is dropped. */
function domainsFrom(frontmatter: ObjectEnvelope | undefined) {
  const raw = Array.isArray(frontmatter?.internal_domains) ? frontmatter.internal_domains as unknown[] : [];
  return [...new Set(raw.map(normalizeDomain).filter((domain): domain is string => Boolean(domain)))];
}

/** Self addresses stored in the setting file; junk from hand edits is dropped. */
function selfEmailsFrom(frontmatter: ObjectEnvelope | undefined) {
  const raw = Array.isArray(frontmatter?.self_emails) ? frontmatter.self_emails as unknown[] : [];
  return [...new Set(raw.map(normalizeEmail).filter((email): email is string => Boolean(email)))];
}

/** #75: a list-valued synced setting; a missing file is "<name> setting was removed". */
function listSetting(ctx: AppContext, spec: SyncedSettingSpec) {
  return new SyncedSetting(ctx, { ...spec, removedMessage: `${spec.name} setting was removed; reload and try again` });
}

const settingIn = (index: Pick<AppContext["index"], "all">, relativePath: string) => index.all().find((object) => object.frontmatter.type === "app-setting" && object.relativePath === relativePath);

/** How a Person's External flag was decided, for the UI and the Agent Index. */
export type ExternalSource = "self" | "override" | "email" | "stored";

/**
 * Whether a person is outside the company. The self person never is; a manual override
 * (`is_external_override`) wins; otherwise any internal email address makes the person internal
 * (colleagues may also list a personal address). Without any email, or with no internal domains set, the stored `is_external` stands.
 */
export function externalStatus(person: Pick<LifeOSObject, "frontmatter">, internalDomains: readonly string[]): { isExternal: boolean; source: ExternalSource } {
  const { frontmatter } = person;
  if (frontmatter.is_self === true) return { isExternal: false, source: "self" };
  if (typeof frontmatter.is_external_override === "boolean") return { isExternal: frontmatter.is_external_override, source: "override" };
  const emails = personEmails(person as LifeOSObject);
  if (emails.length && internalDomains.length) return { isExternal: !emails.some((email) => internalDomains.includes(email.split("@")[1]!)), source: "email" };
  return { isExternal: frontmatter.is_external === true, source: "stored" };
}

/**
 * The display-label read model (#39), used by badges, pickers and the Agent Index (#43).
 * `name` is the short, unambiguous name; `label` is the text to show: `name` plus `suffix` for External people.
 */
export type PersonLabel = { id: string; name: string; label: string; suffix?: typeof EXTERNAL_SUFFIX; isExternal: boolean; externalSource: ExternalSource; unreviewed: boolean };

const cleanText = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

/**
 * Labels for every person among `objects`. The first name by default; first + last name while another
 * active person shares the first name (compared ignoring case and accents). Pure: callers pass the
 * current index, so labels change as soon as people are added, renamed or deleted.
 */
/** Internal domains from the indexed setting file, empty when unset (#39, #54). Every "is this person external?" check uses this. */
export function internalDomainsOf(index: Pick<AppContext["index"], "all">) {
  return domainsFrom(settingIn(index, SyncedSetting.relativePathOf(internalDomainsKey))?.frontmatter);
}

/** Whether a new address on `domain` is External: only decidable once internal domains are set. */
export function isExternalDomain(internalDomains: readonly string[], domain: string) {
  return internalDomains.length > 0 && !internalDomains.includes(domain);
}

/** The user's own addresses from the indexed setting file; empty when unset (#54). */
/** The addresses a "Not a person" Person holds (CONTEXT.md, Ignored address): its emails, or the address it is named by. */
function notAPersonAddresses(person: Pick<LifeOSObject, "frontmatter">) {
  const address = addressInName(person.frontmatter.title)?.email;
  return [...new Set([...personEmails(person as LifeOSObject), ...(address ? [address] : [])])];
}

/** People marked "Not a person" (mailing lists, shared mailboxes), deleted ones excluded. */
function notAPersonPeople(index: Pick<AppContext["index"], "all">) {
  return index.all().filter((object) => object.frontmatter.type === "person" && object.frontmatter.not_a_person === true && !object.frontmatter.deleted_at);
}

/** Ignored addresses: invites never turn them into Attendees. They live on the "Not a person" People themselves. */
export function ignoredAddressesOf(index: Pick<AppContext["index"], "all">) {
  return [...new Set(notAPersonPeople(index).flatMap(notAPersonAddresses))];
}

/** The attendee list saved with a meeting: the invite's labels, without Ignored addresses (or rooms, which connectors drop). */
export function attendeeSnapshot(event: CalendarEvent, index: Pick<AppContext["index"], "all">) {
  const ignored = ignoredAddressesOf(index);
  if (!ignored.length) return [...event.attendees];
  // Google lists labels and details in the same order; otherwise a label is matched by the address it holds.
  const details = event.attendeeDetails?.length === event.attendees.length ? event.attendeeDetails : undefined;
  return event.attendees.filter((label, position) => {
    const email = normalizeEmail(details?.[position]?.email) ?? addressInName(label)?.email;
    return !(email && ignored.includes(email));
  });
}

export function selfEmailsOf(index: Pick<AppContext["index"], "all">) {
  return selfEmailsFrom(settingIn(index, SyncedSetting.relativePathOf(selfEmailsKey))?.frontmatter);
}

/** #76: set while the user's own addresses or the internal domains are unset, so Today and System Health can point to Settings. */
export interface PeopleSetupWarning { selfEmailsMissing: boolean; internalDomainsMissing: boolean }

/** Undefined once both settings are saved. */
export function peopleSetupWarning(index: Pick<AppContext["index"], "all">): PeopleSetupWarning | undefined {
  const selfEmailsMissing = selfEmailsOf(index).length === 0;
  const internalDomainsMissing = internalDomainsOf(index).length === 0;
  return selfEmailsMissing || internalDomainsMissing ? { selfEmailsMissing, internalDomainsMissing } : undefined;
}

export function personDisplayLabels(objects: ReadonlyArray<Pick<LifeOSObject, "frontmatter">>, internalDomains: readonly string[]): PersonLabel[] {
  const people = objects.filter((object) => object.frontmatter.type === "person");
  return people.map((person) => {
    // Full name (first + family); without a family name the title is the best full name there is (it may be one word).
    const first = cleanText(person.frontmatter.given_name);
    const family = cleanText(person.frontmatter.family_name);
    const name = first && family ? `${first} ${family}` : cleanText(person.frontmatter.title) || first || "Unnamed";
    const { isExternal, source } = externalStatus(person, internalDomains);
    return { id: person.frontmatter.id, name, label: isExternal ? name + EXTERNAL_SUFFIX : name, ...(isExternal ? { suffix: EXTERNAL_SUFFIX } : {}), isExternal, externalSource: source, unreviewed: isUnreviewed(person) };
  });
}

/** #87: created automatically (calendar, adoption) and not yet saved or confirmed by the user (PRD story 72). */
export const isUnreviewed = (person: Pick<LifeOSObject, "frontmatter">) => isUnreviewedPerson(person.frontmatter);

/** One attendee as the matcher sees it. Name-only connectors give strings; a bare address counts as an email. */
function attendeesOf(event: CalendarEvent): CalendarAttendee[] {
  // An attendee known only by an address in its name is that email (no bare-address People).
  const named = (attendee: CalendarAttendee): CalendarAttendee => {
    const address = attendee.email ? undefined : addressInName(attendee.displayName);
    if (!address) return attendee;
    const { displayName: _address, ...rest } = attendee;
    return { ...rest, email: address.email, ...(address.displayName ? { displayName: address.displayName } : {}) };
  };
  return (event.attendeeDetails ?? event.attendees.map((label): CalendarAttendee => ({ displayName: label }))).map(named);
}

/** People for calendar attendees (#38): matched by email, created when unknown, the user always the self person. */
export class PeopleModule {
  /** Resolution runs one call at a time, so concurrent meetings sharing a new attendee agree on one person. */
  private readonly queue = new OneAtATime();

  private readonly internalDomainsSetting: SyncedSetting;
  private readonly selfEmailsSetting: SyncedSetting;

  constructor(private readonly ctx: AppContext) {
    this.internalDomainsSetting = listSetting(ctx, {
      key: internalDomainsKey, title: "Internal domains", name: "Internal domains",
      body: "# Internal domains\n\nEmail domains of your own organisations. People with addresses only on other domains are shown as External (\"Name - ext\").\n"
    });
    this.selfEmailsSetting = listSetting(ctx, {
      key: selfEmailsKey, title: "My email addresses", name: "Your email addresses",
      body: "# My email addresses\n\nEvery address you use. Calendar attendees with one of these addresses are you (the self person).\n"
    });
  }

  /** Internal domains from the indexed setting file (empty when unset). Synchronous so labels stay a cheap read. */
  internalDomains() {
    return internalDomainsOf(this.ctx.index);
  }

  /** #76: present while the user's own addresses or the internal domains are unset. */
  setupWarning() {
    return peopleSetupWarning(this.ctx.index);
  }

  /** Display labels for all people, deleted ones included so old references still read well. */
  labels() {
    return personDisplayLabels(this.ctx.index.all(), this.internalDomains());
  }

  /** Read from disk so another device's edit is seen at once (as for calendar preferences). */
  async getInternalDomains(): Promise<{ domains: string[]; contentHash?: string }> {
    const current = await this.internalDomainsSetting.read();
    return { domains: domainsFrom(current?.frontmatter), ...(current ? { contentHash: current.contentHash } : {}) };
  }

  /** The user's own addresses (#54), read from disk like the internal domains. Empty when unset. */
  async getSelfEmails(): Promise<{ emails: string[]; contentHash?: string }> {
    const current = await this.selfEmailsSetting.read();
    return { emails: selfEmailsFrom(current?.frontmatter), ...(current ? { contentHash: current.contentHash } : {}) };
  }

  /** Saves the user's addresses (lowercased, de-duplicated). Blank entries are ignored; invalid ones are named in the error. An empty list is allowed. */
  async saveSelfEmails(input: unknown[], expectedHash?: string) {
    const { values: emails, contentHash } = await this.saveListSetting(this.selfEmailsSetting, {
      field: "self_emails", normalize: normalizeEmail, invalid: "Not an email address"
    }, input, expectedHash);
    return { emails, contentHash };
  }

  /** The Ignored addresses, one entry per "Not a person" Person, so each can be undone. */
  ignoredAddresses(): Array<{ personId: string; title: string; emails: string[]; contentHash: string }> {
    return notAPersonPeople(this.ctx.index).map((person) => ({ personId: person.frontmatter.id, title: String(person.frontmatter.title), emails: notAPersonAddresses(person), contentHash: person.contentHash }));
  }

  /** The "Not a person" People themselves (archived, so the People rollup leaves them out), for the People filter. */
  notAPersonPeople(): LifeOSObject[] {
    return notAPersonPeople(this.ctx.index);
  }

  /**
   * "Not a person": the Person is flagged and archived in one write, so its addresses become Ignored addresses.
   * One file, so no crash-recovery journal is needed (ADR 0013); repeating it changes nothing.
   */
  async markNotAPerson(id: string, expectedHash: string) {
    const { ctx } = this;
    const person = ctx.required(id, "person");
    if (person.frontmatter.is_self === true) throw new Error("This is you; you cannot mark yourself as not a person");
    if (!notAPersonAddresses(person).length) throw new Error("This person has no email address to ignore");
    if (person.frontmatter.not_a_person === true && person.frontmatter.archived_at) return person;
    const now = new Date().toISOString();
    const updated = await ctx.update(person, { not_a_person: true, archived_at: person.frontmatter.archived_at ?? now }, { expectedHash, now });
    await ctx.writeAudit("person.not-a-person", id, now, {});
    await ctx.rebuildIndex();
    return updated;
  }

  /** Undoes "Not a person": the Person is live again and invites use its addresses again. One write. */
  async undoNotAPerson(id: string, expectedHash: string) {
    const { ctx } = this;
    const person = ctx.required(id, "person");
    if (person.frontmatter.not_a_person !== true) return person;
    const now = new Date().toISOString();
    const updated = await ctx.update(person, { not_a_person: undefined, archived_at: undefined }, { expectedHash, now });
    await ctx.writeAudit("person.not-a-person-undone", id, now, {});
    await ctx.rebuildIndex();
    return updated;
  }

  /** Saves the internal domains (lowercased, "@" stripped, de-duplicated). Blank entries are ignored; invalid ones are named in the error. */
  async saveInternalDomains(input: unknown[], expectedHash?: string) {
    const { values: domains, contentHash } = await this.saveListSetting(this.internalDomainsSetting, {
      field: "internal_domains", normalize: normalizeDomain, invalid: "Not a domain name", required: "Enter at least one internal domain"
    }, input, expectedHash);
    return { domains, contentHash };
  }

  /**
   * #75: saves a list-valued app setting file (self emails, internal domains). Blank entries are ignored, the rest are
   * normalized and de-duplicated, invalid ones are named in the error. `required`, when given, is the error for an empty list.
   */
  private async saveListSetting(setting: SyncedSetting, list: { field: string; normalize: (value: unknown) => string | undefined; invalid: string; required?: string }, input: unknown[], expectedHash?: string) {
    const entries = (Array.isArray(input) ? input : []).filter((value) => typeof value !== "string" || value.trim());
    const invalid = entries.filter((value) => !list.normalize(value)).map(String);
    if (invalid.length) throw new Error(`${list.invalid}: ${invalid.join(", ")}`);
    const values = [...new Set(entries.map((value) => list.normalize(value)!))];
    if (list.required && !values.length) throw new Error(list.required);
    const written = await setting.save(() => ({ [list.field]: values }), expectedHash);
    return { values, contentHash: written.contentHash };
  }

  /**
   * Manual override of the External flag: `true` or `false` pins it, `null` returns to the email rule.
   * `is_external` is rewritten to the effective value so the file reads correctly outside the app.
   */
  async setExternal(id: string, value: boolean | null, expectedHash: string) {
    if (value !== true && value !== false && value !== null) throw new Error("External must be true, false or null");
    const { ctx } = this;
    const person = ctx.required(id, "person");
    if (person.frontmatter.is_self === true) throw new Error("The self person is always internal");
    const before = typeof person.frontmatter.is_external_override === "boolean" ? person.frontmatter.is_external_override : null;
    if (value === before) return person;
    const override = value ?? undefined;
    const isExternal = externalStatus({ frontmatter: { ...person.frontmatter, is_external_override: override } }, this.internalDomains()).isExternal;
    const now = new Date().toISOString();
    const updated = await ctx.update(person, { is_external_override: override, is_external: isExternal }, { expectedHash, now });
    await ctx.writeAudit("person.external-changed", id, now, { from: before, to: value, is_external: isExternal });
    await ctx.rebuildIndex();
    return updated;
  }

  /**
   * #214: adds an address to a person, lowercased. An address already on this person writes nothing; one on another
   * person who is not deleted (merged-away people are deleted) is refused with PersonEmailTakenError. Other identifiers stay.
   */
  async addEmail(id: string, value: unknown, expectedHash: string) {
    const { ctx } = this;
    const email = normalizeEmail(value);
    if (!email) throw new Error("Enter a valid email address");
    const person = ctx.required(id, "person");
    if (personEmails(person).includes(email)) return person;
    const holder = ctx.index.all().find((other) => other.frontmatter.type === "person" && other.frontmatter.id !== id && !other.frontmatter.deleted_at && personEmails(other).includes(email));
    if (holder) throw new PersonEmailTakenError(email, holder.frontmatter.id, String(holder.frontmatter.title));
    const identifiers = [...(Array.isArray(person.frontmatter.identifiers) ? person.frontmatter.identifiers : []), { kind: "email", value: email } satisfies PersonIdentifier];
    const now = new Date().toISOString();
    const updated = await ctx.update(person, { identifiers }, { expectedHash, now });
    await ctx.writeAudit("person.email-added", id, now, {});
    await ctx.rebuildIndex();
    return updated;
  }

  /** #214: removes an address from a person (any casing). One that is not there writes nothing. */
  async removeEmail(id: string, value: unknown, expectedHash: string) {
    const { ctx } = this;
    const email = normalizeEmail(value);
    if (!email) throw new Error("Enter a valid email address");
    const person = ctx.required(id, "person");
    if (!personEmails(person).includes(email)) return person;
    const identifiers = (person.frontmatter.identifiers as unknown[]).filter((identifier) => identifierEmail(identifier) !== email);
    const now = new Date().toISOString();
    const updated = await ctx.update(person, { identifiers }, { expectedHash, now });
    await ctx.writeAudit("person.email-removed", id, now, {});
    await ctx.rebuildIndex();
    return updated;
  }

  /** #87: the user confirms an automatically created person. Guarded by the content hash; repeating it writes nothing. */
  async confirmReviewed(id: string, expectedHash: string) {
    const { ctx } = this;
    const person = ctx.required(id, "person");
    if (!isUnreviewed(person)) return person;
    const now = new Date().toISOString();
    const updated = await ctx.update(person, { review_state: "reviewed" }, { expectedHash, now });
    await ctx.writeAudit("person.reviewed", id, now, { from: "unreviewed" });
    await ctx.rebuildIndex();
    return updated;
  }

  /** Self addresses from the indexed setting file; synchronous for matching. */
  private selfEmails() {
    return selfEmailsOf(this.ctx.index);
  }

  /** Read-only: the existing person, or an unsaved stand-in with the name a real one would get. */
  previewAttendees(event: CalendarEvent, synthetic: (title: string) => LifeOSObject) {
    const byEmail = this.peopleByEmail();
    const self = this.selfPerson();
    const selfEmails = this.selfEmails();
    return attendeesOf(event).map((attendee) => {
      const email = normalizeEmail(attendee.email);
      const known = attendee.self || (email && selfEmails.includes(email)) ? self : email ? byEmail.get(email) : undefined;
      return known ?? synthetic(email ? derivePersonName(email, attendee.displayName).title : attendee.displayName ?? "Unknown attendee");
    }).filter((person, index, all) => all.findIndex((other) => other.frontmatter.id === person.frontmatter.id) === index);
  }

  resolveAttendees(event: CalendarEvent, timestamp: string, ensureNamed: (name: string) => Promise<LifeOSObject>) {
    return this.queue.run("attendees", () => this.resolveSerialized(event, timestamp, ensureNamed));
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
    const selfEmails = this.selfEmails();
    const ignored = ignoredAddressesOf(ctx.index);
    const people: LifeOSObject[] = [];
    for (const attendee of attendees) {
      const email = normalizeEmail(attendee.email);
      // An Ignored address is never an Attendee (it names a mailing list or shared mailbox, not a person).
      if (email && !attendee.self && ignored.includes(email) && !selfEmails.includes(email)) continue;
      let person = attendee.self || (email && selfEmails.includes(email)) ? self : email ? byEmail.get(email) : undefined;
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
    return this.ctx.index.all().find((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true && isLive(object));
  }

  /**
   * People by lowercased email. The self person's addresses always point to it. An email is an identifier, so it
   * reaches an archived person too (decision 2026-10-10); a live person with the same email wins.
   */
  private peopleByEmail() {
    const byEmail = new Map<string, LifeOSObject>();
    for (const person of byIdentifier(this.ctx.index.all().filter((object) => object.frontmatter.type === "person"))) {
      for (const email of personEmails(person)) if (!byEmail.has(email) || person.frontmatter.is_self === true) byEmail.set(email, person);
    }
    return byEmail;
  }

  private async ensureSelfEmails(self: LifeOSObject, timestamp: string) {
    const have = personEmails(self);
    const missing = this.selfEmails().filter((email) => !have.includes(email));
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
        is_external: isExternalDomain(this.internalDomains(), domain),
        ...(organization ? { organization_name: organization } : {})
      },
      body: `# ${title}\n`
    });
  }
}
