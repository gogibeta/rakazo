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

test("sets and changes the wallet password, and rejects a wrong current password", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `wallet-vault-${stamp}@rakazo.test`, "password12", "Vault Owner");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "wallets");

  await settings.getByLabel("Wallet password", { exact: true }).fill("vault-password-one");
  await settings.getByLabel("Confirm wallet password", { exact: true }).fill("vault-password-one");
  await settings.getByRole("button", { name: "Set wallet password", exact: true }).click();

  // Set: the form becomes the change form, and the status the server returns
  // says only that a password exists — never the password.
  await expect(settings.getByLabel("Current wallet password", { exact: true })).toBeVisible();
  const status = JSON.stringify(await rpc(page, "wallets/vaultStatus", {}));
  expect(status).toContain('"configured":true');
  expect(status).not.toContain("vault-password-one");
  await captureScreenshot(page, testInfo, "wallet-vault-password");

  // A wrong current password gets the one generic rejection.
  await settings.getByLabel("Current wallet password", { exact: true }).fill("vault-password-nope");
  await settings.getByLabel("New wallet password", { exact: true }).fill("vault-password-two");
  await settings.getByLabel("Confirm wallet password", { exact: true }).fill("vault-password-two");
  await settings.getByRole("button", { name: "Change wallet password", exact: true }).click();
  await expect(settings.getByText("The wallet password could not be verified.")).toBeVisible();

  // The right current password changes it.
  await settings.getByLabel("Current wallet password", { exact: true }).fill("vault-password-one");
  await settings.getByRole("button", { name: "Change wallet password", exact: true }).click();
  await expect(settings.getByText("Saved")).toBeVisible();
});
