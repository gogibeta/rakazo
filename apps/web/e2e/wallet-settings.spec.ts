import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

// The well-known public Hardhat test account #0: a published test vector,
// not anyone's wallet. The server derives this address from the key.
const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

test("adds a wallet from its key, shows the derived address, and never returns the secret", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `wallets-${stamp}@rakazo.test`, "password12", "Wallet Owner");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "wallets");

  await expect(settings.getByText("Use burner wallets only")).toBeVisible();
  await settings.getByLabel("Name", { exact: true }).fill("Airdrop burner");
  await settings.getByRole("textbox", { name: "Private key or seed phrase" }).fill(HARDHAT_KEY);
  await settings.getByRole("button", { name: "Add wallet", exact: true }).click();

  const wallet = settings.locator("li", { hasText: "Airdrop burner" });
  await expect(wallet).toBeVisible();
  await expect(wallet.getByText(`${HARDHAT_ADDRESS} · EVM`)).toBeVisible();
  await captureScreenshot(page, testInfo, "wallets-list");

  // The list the server returns carries the address, never the secret.
  const listed = JSON.stringify(await rpc(page, "wallets/list", {}));
  expect(listed).toContain(HARDHAT_ADDRESS);
  expect(listed).not.toContain(HARDHAT_KEY);
  expect(listed).not.toContain(HARDHAT_KEY.slice(2));

  await wallet.getByRole("button", { name: "History", exact: true }).click();
  await expect(wallet.getByText("Not used yet.")).toBeVisible();

  await wallet.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(settings.locator("li", { hasText: "Airdrop burner" })).toHaveCount(0);
});
