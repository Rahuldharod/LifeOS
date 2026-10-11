import { describe, expect, it } from "vitest";
import { parseRoute, routePath } from "./routes.js";
import { parseReferenceSettingsId, referenceCardIdFromRoute, referenceRouteInSettings, referenceSettingsCardId, referenceSettingsId } from "./referenceSettingsRoutes.js";

const ID = "01995d3e-912b-7357-8aa6-9816c1ad90a5";

describe("reference Settings routes (#140)", () => {
  it("maps every legacy reference route to the matching Settings record", () => {
    expect(referenceRouteInSettings({ view: "Projects", id: ID })).toEqual({ view: "Settings", id: referenceSettingsId("project", ID) });
    expect(referenceRouteInSettings({ view: "Clients", id: ID })).toEqual({ view: "Settings", id: referenceSettingsId("client", ID) });
    expect(referenceRouteInSettings({ view: "Products", id: ID })).toEqual({ view: "Settings", id: referenceSettingsId("product", ID) });
    expect(referenceRouteInSettings({ view: "People", id: ID })).toEqual({ view: "Settings", id: referenceSettingsId("person", ID) });
  });

  it("round-trips a record route and selects its fixed Settings card", () => {
    const route = { view: "Settings" as const, id: referenceSettingsId("person", ID) };
    const parsed = parseRoute(routePath(route));
    expect(parsed).toEqual(route);
    expect(parseReferenceSettingsId(parsed?.id)).toEqual({ type: "person", recordId: ID });
    expect(referenceCardIdFromRoute(parsed?.id)).toBe(referenceSettingsCardId("person"));
  });

  it("leaves unrelated routes and Settings cards unchanged", () => {
    expect(referenceRouteInSettings({ view: "Tasks", id: ID })).toEqual({ view: "Tasks", id: ID });
    expect(referenceCardIdFromRoute("settings-today")).toBe("settings-today");
  });
});
