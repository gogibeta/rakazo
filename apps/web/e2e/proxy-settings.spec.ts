import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("adds proxies from the fields and from a pasted URL, showing no password", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `proxies-${stamp}@rakazo.test`, "password12", "Proxy Owner");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "proxies");

  await settings.getByLabel("Name", { exact: true }).fill("Mumbai");
  await settings.getByLabel("Host", { exact: true }).fill("pr.example.com");
  await settings.getByLabel("Port", { exact: true }).fill("7777");
  await settings.getByLabel("Country").fill("in");
  await settings.getByLabel("Username").fill("customer-42");
  await settings.getByLabel("Password").fill(`fake-password-${stamp}`);
  await settings.getByRole("button", { name: "Add proxy", exact: true }).click();

  const mumbai = settings.locator("li", { hasText: "Mumbai" });
  await expect(mumbai).toBeVisible();
  await expect(mumbai.getByText("pr.example.com:7777 · IN · HTTP")).toBeVisible();
  await captureScreenshot(page, testInfo, "proxies-list");

  await settings.getByRole("button", { name: "Paste a URL instead", exact: true }).click();
  await settings.getByLabel("Name", { exact: true }).fill("Frankfurt");
  await settings
    .getByLabel("Proxy URL", { exact: true })
    .fill("socks5://user:pw@proxy.example.com:1080");
  await settings.getByRole("button", { name: "Add proxy", exact: true }).click();

  const frankfurt = settings.locator("li", { hasText: "Frankfurt" });
  await expect(frankfurt).toBeVisible();
  await expect(frankfurt.getByText("proxy.example.com:1080 · SOCKS5")).toBeVisible();

  // The list the server returns carries no password, composed or otherwise.
  const listed = JSON.stringify(await rpc(page, "proxies/list", {}));
  expect(listed).toContain("pr.example.com");
  expect(listed).not.toContain(`fake-password-${stamp}`);
  expect(listed).not.toContain("customer-42-cc-IN");

  await mumbai.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(settings.locator("li", { hasText: "Mumbai" })).toHaveCount(0);
  await expect(frankfurt).toBeVisible();
});
