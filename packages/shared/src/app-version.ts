// #208 (PB-032): the App version is a calendar version, `YY.MM.DD.N`: the Paris date of a merge to main and which
// merge of that day it was. It is worked out from git history, so there is no bump commit and no tag.

/** One commit on main's first-parent line; `committedAt` is the ISO time git prints for `%cI`. */
export interface MainCommit { commit: string; committedAt: string }

const parisDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "2-digit", month: "2-digit", day: "2-digit" });
const dayOf = (committedAt: string) => parisDay.format(new Date(committedAt));

/**
 * `main` is main's first-parent history, newest first, starting at the last main commit the build contains.
 * A build of any other commit, or any dev-runtime build, adds `-dev+<short commit>`.
 */
export function appVersion(main: readonly MainCommit[], build: string, options: { dev?: boolean } = {}): string {
  const base = main[0];
  if (!base) return "unknown";
  const day = dayOf(base.committedAt);
  const n = main.filter((entry) => dayOf(entry.committedAt) === day).length;
  const version = `${day.replaceAll("-", ".")}.${n}`;
  return options.dev || build !== base.commit ? `${version}-dev+${build.slice(0, 7)}` : version;
}
