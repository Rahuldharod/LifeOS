import { randomInt } from "node:crypto";
import type { AppInfo } from "@lifeos/shared";
import type { InboxStore } from "./ports.js";

/**
 * ADR 0022 (PB-018): App Feedback is one Markdown file per submission in `_inbox/feedback/`. It is not an object:
 * it never goes through `ObjectStore`, needs no device lease, and adoption never reads the folder.
 */

export const feedbackLabels = ["bug", "feature"] as const;
export type FeedbackLabel = typeof feedbackLabels[number];
export const feedbackContractVersion = 1;

export interface FeedbackInput {
  label: FeedbackLabel;
  /** The user's words, kept exactly as typed. */
  text: string;
  /** The tab the user was on, e.g. `Tasks`. */
  page: string;
  /** `lifeos://object/<id>` of the open note, meeting or item; left out when none is open. */
  object?: string;
}


/** Same name the HTTP layer maps to a 500: the request was fine, the file could not be written. */
export class FeedbackWriteError extends Error { override name = "FeedbackWriteError"; }

const objectLink = /^lifeos:\/\/object\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

/** The date and time in the user's zone, for the file name only; stored instants are UTC. */
function localParts(now: Date, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}${part("minute")}${part("second")}` };
}

const deviceSlug = (device: string) => device.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "device";
const randomSuffix = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");

export class FeedbackModule {
  constructor(private readonly inbox: InboxStore | undefined, private readonly deviceId: string, private readonly appInfo: AppInfo, private readonly timeZone?: string) {}

  async submit(input: FeedbackInput, options: { now?: Date } = {}): Promise<{ file: string; message: string }> {
    if (!feedbackLabels.includes(input.label)) throw new Error("label must be bug or feature");
    if (typeof input.text !== "string" || !input.text.trim()) throw new Error("Feedback text is required");
    if (typeof input.page !== "string" || !input.page.trim()) throw new Error("page is required");
    if (input.object !== undefined && !objectLink.test(input.object)) throw new Error("object must be a lifeos://object/<id> link");
    if (!this.inbox) throw new Error("The inbox folder is not configured, so feedback cannot be saved");
    const now = options.now ?? new Date();
    const local = localParts(now, this.timeZone);
    try {
      await this.inbox.ensureFolders();
      const taken = new Set((await this.inbox.list("feedback")).map((file) => file.name));
      const stem = `${local.date}-${local.time}-${deviceSlug(this.deviceId)}`;
      let name = `${stem}-${randomSuffix()}.md`;
      while (taken.has(name)) name = `${stem}-${randomSuffix()}.md`;
      const file = await this.inbox.writeDocument("feedback", name, {
        lifeos_feedback: feedbackContractVersion,
        label: input.label,
        captured_at: now.toISOString(),
        page: input.page,
        ...(input.object ? { object: input.object } : {}),
        app_version: this.appInfo.version,
        app_commit: this.appInfo.commit,
        device: this.deviceId
      }, input.text);
      return { file: file.relativePath, message: "Feedback saved" };
    } catch (error) {
      throw new FeedbackWriteError(`Could not save feedback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
