import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { foldForSearch, markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import type { CalendarAttendee, CalendarEvent } from "./ports.js";
import { isLive, OneAtATime } from "./support.js";

/** The synced internal-domains setting (ADR 0005): one fixed file. Unset means nobody is External by email (#54). */
const internalDomainsPath = "settings/internal-domains.md";
/** The synced self-email setting (#54): every address of the user, all resolving to the single self person (PRD story 73). Unset means none. */
const selfEmailsPath = "settings/self-emails.md";
/** Appended to an External person's label. The words are always there, so red styling is never the only signal. */
export const EXTERNAL_SUFFIX = " - ext";
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

const isActivePerson = (person: Pick<LifeOSObject, "frontmatter">) => person.frontmatter.type === "person" && isLive(person);
const cleanText = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

/**
 * Labels for every person among `objects`. The first name by default; first + last name while another
 * active person shares the first name (compared ignoring case and accents). Pure: callers pass the
 * current index, so labels change as soon as people are added, renamed or deleted.
 */
/** Internal domains from the indexed setting file, empty when unset (#39, #54). Every "is this person external?" check uses this. */
export function internalDomainsOf(index: Pick<AppContext["index"], "all">) {
  return domainsFrom(settingIn(index, internalDomainsPath)?.frontmatter);
}

/** Whether a new address on `domain` is External: only decidable once internal domains are set. */
export function isExternalDomain(internalDomains: readonly string[], domain: string) {
  return internalDomains.length > 0 && !internalDomains.includes(domain);
}

/** The user's own addresses from the indexed setting file; empty when unset (#54). */
export function selfEmailsOf(index: Pick<AppContext["index"], "all">) {
  return selfEmailsFrom(settingIn(index, selfEmailsPath)?.frontmatter);
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
  const firstName = (person: Pick<LifeOSObject, "frontmatter">) => cleanText(person.frontmatter.given_name) || cleanText(person.frontmatter.title).split(" ")[0] || "Unnamed";
  const holders = new Map<string, Set<string>>();
  for (const person of people.filter(isActivePerson)) {
    const key = foldForSearch(firstName(person));
    holders.set(key, (holders.get(key) ?? new Set<string>()).add(person.frontmatter.id));
  }
  return people.map((person) => {
    const first = firstName(person);
    const shared = [...holders.get(foldForSearch(first)) ?? []].some((id) => id !== person.frontmatter.id);
    const family = cleanText(person.frontmatter.family_name);
    // Without a family name, the title is the best longer name there is (it may equal the first name).
    const name = !shared ? first : family ? `${first} ${family}` : cleanText(person.frontmatter.title) || first;
    const { isExternal, source } = externalStatus(person, internalDomains);
    return { id: person.frontmatter.id, name, label: isExternal ? name + EXTERNAL_SUFFIX : name, ...(isExternal ? { suffix: EXTERNAL_SUFFIX } : {}), isExternal, externalSource: source, unreviewed: isUnreviewed(person) };
  });
}

/** #87: created automatically (calendar, adoption) and not yet saved or confirmed by the user (PRD story 72). */
export const isUnreviewed = (person: Pick<LifeOSObject, "frontmatter">) => person.frontmatter.review_state === "unreviewed";

/** One attendee as the matcher sees it. Name-only connectors give strings; a bare address counts as an email. */
function attendeesOf(event: CalendarEvent): CalendarAttendee[] {
  if (event.attendeeDetails) return event.attendeeDetails;
  return event.attendees.map((label) => normalizeEmail(label) ? { email: label } : { displayName: label });
}

/** People for calendar attendees (#38): matched by email, created when unknown, the user always the self person. */
export class PeopleModule {
  /** Resolution runs one call at a time, so concurrent meetings sharing a new attendee agree on one person. */
  private readonly queue = new OneAtATime();

  constructor(private readonly ctx: AppContext) {}

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
    const current = await this.readSetting(internalDomainsPath);
    return { domains: domainsFrom(current?.frontmatter), ...(current ? { contentHash: current.contentHash } : {}) };
  }

  /** The user's own addresses (#54), read from disk like the internal domains. Empty when unset. */
  async getSelfEmails(): Promise<{ emails: string[]; contentHash?: string }> {
    const current = await this.readSetting(selfEmailsPath);
    return { emails: selfEmailsFrom(current?.frontmatter), ...(current ? { contentHash: current.contentHash } : {}) };
  }

  /** Saves the user's addresses (lowercased, de-duplicated). Blank entries are ignored; invalid ones are named in the error. An empty list is allowed. */
  async saveSelfEmails(input: unknown[], expectedHash?: string) {
    const { values: emails, contentHash } = await this.saveListSetting({
      relativePath: selfEmailsPath, settingKey: "self-emails", field: "self_emails", name: "Your email addresses", title: "My email addresses",
      body: "# My email addresses\n\nEvery address you use. Calendar attendees with one of these addresses are you (the self person).\n",
      normalize: normalizeEmail, invalid: "Not an email address"
    }, input, expectedHash);
    return { emails, contentHash };
  }

  /** Saves the internal domains (lowercased, "@" stripped, de-duplicated). Blank entries are ignored; invalid ones are named in the error. */
  async saveInternalDomains(input: unknown[], expectedHash?: string) {
    const { values: domains, contentHash } = await this.saveListSetting({
      relativePath: internalDomainsPath, settingKey: "internal-domains", field: "internal_domains", name: "Internal domains", title: "Internal domains",
      body: "# Internal domains\n\nEmail domains of your own organisations. People with addresses only on other domains are shown as External (\"Name - ext\").\n",
      normalize: normalizeDomain, invalid: "Not a domain name", required: "Enter at least one internal domain"
    }, input, expectedHash);
    return { domains, contentHash };
  }

  /**
   * #75: saves a list-valued app setting file (self emails, internal domains). Blank entries are ignored, the rest are
   * normalized and de-duplicated, invalid ones are named in the error. A guarded write: a stale or missing file is a
   * conflict named after the setting (`name`). `required`, when given, is the error for an empty list.
   */
  private async saveListSetting(setting: { relativePath: string; settingKey: string; field: string; name: string; title: string; body: string; normalize: (value: unknown) => string | undefined; invalid: string; required?: string }, input: unknown[], expectedHash?: string) {
    const { ctx } = this;
    const entries = (Array.isArray(input) ? input : []).filter((value) => typeof value !== "string" || value.trim());
    const invalid = entries.filter((value) => !setting.normalize(value)).map(String);
    if (invalid.length) throw new Error(`${setting.invalid}: ${invalid.join(", ")}`);
    const values = [...new Set(entries.map((value) => setting.normalize(value)!))];
    if (setting.required && !values.length) throw new Error(setting.required);
    const current = await this.readSetting(setting.relativePath);
    if (current && current.contentHash !== expectedHash) throw new ObjectConflictError(`${setting.name} changed on another device; reload and try again`);
    if (!current && expectedHash) throw new ObjectConflictError(`${setting.name} setting was removed; reload and try again`);
    const now = new Date().toISOString();
    const written = await ctx.objects.write({
      relativePath: setting.relativePath,
      expectedHash: current?.contentHash,
      frontmatter: {
        ...current?.frontmatter,
        ...(current ? { revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: ctx.deviceId } : ctx.envelope(uuidV7(), "app-setting", setting.title, now)),
        setting_key: setting.settingKey,
        [setting.field]: values
      } as ObjectEnvelope,
      body: current?.body ?? setting.body
    });
    await ctx.rebuildIndex();
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

  private async readSetting(relativePath: string) {
    try { return await this.ctx.objects.read(relativePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
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
    const people: LifeOSObject[] = [];
    for (const attendee of attendees) {
      const email = normalizeEmail(attendee.email);
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
