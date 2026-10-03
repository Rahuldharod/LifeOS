// Type-to-find matching for the note header dropdowns (PB-006): every typed word must appear,
// ignoring case and accents, so "joh" or "jose" shortlists "John" or "José". Names that start a
// word with the query come first, then the rest alphabetically.

export type SearchOption = { id: string; title: string };

export const foldText = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function searchOptions(options: SearchOption[], query: string, exclude: string[] = []): SearchOption[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  const wordStart = (title: string) => words.every((word) => foldText(title).split(/[\s\-_.,()]+/).some((part) => part.startsWith(word)));
  return options
    .filter((option) => !exclude.includes(option.id) && words.every((word) => foldText(option.title).includes(word)))
    .sort((left, right) => Number(wordStart(right.title)) - Number(wordStart(left.title)) || left.title.localeCompare(right.title));
}
