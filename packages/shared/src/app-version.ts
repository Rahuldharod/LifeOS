// #208 (PB-032): the App version is a calendar version, `YY.MM.DD.N`: the Paris date of a merge to main and which
// merge of that day it was. It is worked out from git history, so there is no bump commit and no tag.

/** The running build's identity: its App version and short git commit (ADR 0022, #208). */
export interface AppInfo { version: string; commit: string }
export const unknownAppInfo: AppInfo = { version: "unknown", commit: "unknown" };

/** One commit on main's first-parent line; `committedAt` is the ISO time git prints for `%cI`. */
export interface MainCommit { commit: string; committedAt: string }

export interface BuildHistory {
  /** Main's first-parent history, newest first, from main's tip. */
  main: readonly MainCommit[];
  /** The last main commit the build contains (the merge base of the build and main). */
  base: string;
  /** The full commit the build is made from. */
  buildCommit: string;
  /** A shallow clone only holds part of main's history, so the day's count would be wrong. */
  shallow?: boolean;
  /** A dev-runtime build (`pnpm dev`) is never a release, whatever it is built from. */
  dev?: boolean;
}

const parisDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "2-digit", month: "2-digit", day: "2-digit" });
const dayOf = (committedAt: string) => parisDay.format(new Date(committedAt));

/** The App version of a build: the base's `YY.MM.DD.N`, plus `-dev+<short commit>` unless the build is that main merge. */
export function appVersion({ main, base, buildCommit, shallow, dev }: BuildHistory): string {
  const start = main.findIndex((entry) => entry.commit === base);
  if (shallow || start < 0) return "unknown";
  const history = main.slice(start);
  const day = dayOf(history[0]!.committedAt);
  const n = history.filter((entry) => dayOf(entry.committedAt) === day).length;
  const version = `${day.replaceAll("-", ".")}.${n}`;
  return dev || buildCommit !== base ? `${version}-dev+${buildCommit.slice(0, 7)}` : version;
}
