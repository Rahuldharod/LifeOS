import type { Route, View } from "./routes.js";

export type ReferenceEntityType = "project" | "client" | "product" | "person";

const views: Record<ReferenceEntityType, View> = { project: "Projects", client: "Clients", product: "Products", person: "People" };
const types = Object.fromEntries(Object.entries(views).map(([type, view]) => [view, type])) as Partial<Record<View, ReferenceEntityType>>;
const plurals: Record<ReferenceEntityType, string> = { project: "projects", client: "clients", product: "products", person: "people" };

export const referenceSettingsCardId = (type: ReferenceEntityType) => `settings-reference-${plurals[type]}`;
export const referenceSettingsId = (type: ReferenceEntityType, recordId?: string) => recordId ? `${referenceSettingsCardId(type)}:${recordId}` : referenceSettingsCardId(type);

export function parseReferenceSettingsId(value?: string): { type: ReferenceEntityType; recordId?: string } | undefined {
  if (!value) return undefined;
  for (const type of Object.keys(plurals) as ReferenceEntityType[]) {
    const cardId = referenceSettingsCardId(type);
    if (value === cardId) return { type };
    if (value.startsWith(`${cardId}:`)) return { type, recordId: value.slice(cardId.length + 1) };
  }
  return undefined;
}

/** Existing entity tabs and lifeos links keep working while their canonical destination moves into Settings. */
export function referenceRouteInSettings(route: Route): Route {
  const type = types[route.view];
  return type ? { view: "Settings", id: referenceSettingsId(type, route.id) } : route;
}

/** Dynamic record routes still select the fixed Settings card for that reference type. */
export function referenceCardIdFromRoute(value?: string): string | undefined {
  const reference = parseReferenceSettingsId(value);
  return reference ? referenceSettingsCardId(reference.type) : value;
}
