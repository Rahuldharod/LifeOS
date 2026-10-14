import { expect, test, type Page } from "@playwright/test";
import { recordUrl } from "./fixtures.js";

// #208 (PB-033): the UI App version sits in the nav footer; the About LifeOS card on System shows the UI and server
// App versions and warns when they differ. The server's version is stubbed so the test does not depend on the branch.

async function serverVersion(page: Page, version: string) {
  await page.route("**/api/v1/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), appInfo: { version, commit: "abc1234" } } });
  });
}

test("shows the App version in the nav footer and both versions on System, with no warning when they match", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByLabel("App version");
  await expect(footer).toHaveText(/^\d\d\.\d\d\.\d\d\.\d+(-dev\+[0-9a-f]{7})?$|^unknown$/);
  const uiVersion = (await footer.textContent())!;

  await serverVersion(page, uiVersion);
  await page.goto(recordUrl("System"));
  const about = page.getByRole("region", { name: "About LifeOS" });
  await expect(about.getByText(`UI ${uiVersion}`)).toBeVisible();
  await expect(about.getByText(`Server ${uiVersion}`)).toBeVisible();
  await expect(about.getByText(/run update-app/)).toHaveCount(0);
});

test("warns to run update-app when the server runs a different App version", async ({ page }) => {
  await serverVersion(page, "26.01.01.1");
  await page.goto(recordUrl("System"));
  const about = page.getByRole("region", { name: "About LifeOS" });
  await expect(about.getByText("Server 26.01.01.1")).toBeVisible();
  await expect(about.getByText(/run update-app/)).toBeVisible();
});
