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

  // Removal is a two-step confirmation: the row's Remove asks, the fieldset confirms.
  // A single click must not delete anything.
  await wallet.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = wallet.locator("fieldset");
  await expect(confirm).toBeVisible();
  await expect(wallet).toHaveCount(1);
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(settings.locator("li", { hasText: "Airdrop burner" })).toHaveCount(0);

  // The removal is a soft delete: the row leaves the list, but the server kept it,
  // so the secret is not lost and the wallet can be restored.
  const afterRemoval = JSON.stringify(await rpc(page, "wallets/list", {}));
  expect(afterRemoval).not.toContain("Airdrop burner");
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

test("unlocks the wallet vault for six hours and locks it again", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `wallet-unlock-${stamp}@rakazo.test`, "password12", "Unlock Owner");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "wallets");

  // No unlock section before a wallet password exists.
  await expect(settings.getByText("Unlock wallets")).toHaveCount(0);

  await settings.getByLabel("Wallet password", { exact: true }).fill("unlock-password-one");
  await settings.getByLabel("Confirm wallet password", { exact: true }).fill("unlock-password-one");
  await settings.getByRole("button", { name: "Set wallet password", exact: true }).click();
  await expect(settings.getByLabel("Current wallet password", { exact: true })).toBeVisible();

  // A wrong password is refused generically and stays locked.
  await settings.getByLabel("Unlock password", { exact: true }).fill("unlock-password-nope");
  await settings.getByRole("button", { name: "Unlock for six hours", exact: true }).click();
  await expect(settings.getByText("The wallet password could not be verified.")).toBeVisible();

  await settings.getByLabel("Unlock password", { exact: true }).fill("unlock-password-one");
  await settings.getByRole("button", { name: "Unlock for six hours", exact: true }).click();
  await expect(settings.getByText(/Unlocked until/)).toBeVisible();
  await expect(settings.getByRole("button", { name: "Lock wallets", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "wallet-vault-unlocked");

  // The status the server returns says unlocked with an expiry — never the password.
  const status = JSON.stringify(await rpc(page, "wallets/vaultStatus", {}));
  expect(status).toContain('"unlocked":true');
  expect(status).toContain('"vaultAvailable":true');
  expect(status).not.toContain("unlock-password-one");

  await settings.getByRole("button", { name: "Lock wallets", exact: true }).click();
  await expect(settings.getByText("Unlocking lasts six hours.")).toBeVisible();
  const locked = JSON.stringify(await rpc(page, "wallets/vaultStatus", {}));
  expect(locked).toContain('"unlocked":false');
});

test("migrates a wallet to password protection from Settings", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `wallet-migrate-${stamp}@rakazo.test`, "password12", "Migration Owner");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "wallets");

  await settings.getByLabel("Name", { exact: true }).fill("Airdrop burner");
  await settings.getByRole("textbox", { name: "Private key or seed phrase" }).fill(HARDHAT_KEY);
  await settings.getByRole("button", { name: "Add wallet", exact: true }).click();

  const wallet = settings.locator("li", { hasText: "Airdrop burner" });
  await expect(wallet).toBeVisible();
  // Before a wallet password exists, the wallet says what it needs first.
  await expect(wallet.getByText("Not password protected yet.")).toBeVisible();
  await expect(wallet.getByText("Set a wallet password first.")).toBeVisible();

  await settings.getByLabel("Wallet password", { exact: true }).fill("migration-password-one");
  await settings
    .getByLabel("Confirm wallet password", { exact: true })
    .fill("migration-password-one");
  await settings.getByRole("button", { name: "Set wallet password", exact: true }).click();
  await expect(settings.getByLabel("Current wallet password", { exact: true })).toBeVisible();

  // A wrong password is refused generically and changes nothing.
  await wallet.getByRole("button", { name: "Migrate", exact: true }).click();
  await wallet.getByLabel("Wallet password", { exact: true }).fill("migration-password-nope");
  await wallet.getByRole("button", { name: "Migrate wallet", exact: true }).click();
  await expect(wallet.getByText("The wallet password could not be verified.")).toBeVisible();
  await expect(wallet.getByText("Not password protected yet.")).toBeVisible();

  await wallet.getByLabel("Wallet password", { exact: true }).fill("migration-password-one");
  await wallet.getByRole("button", { name: "Migrate wallet", exact: true }).click();
  // Exact text: the plain substring would also match "Not password
  // protected yet." and pass before the migration has even answered.
  await expect(wallet.getByText("Password protected", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "wallet-migrated");

  const listed = JSON.stringify(await rpc(page, "wallets/list", {}));
  expect(listed).toContain("password_protected");
  expect(listed).not.toContain(HARDHAT_KEY);
  expect(listed).not.toContain("migration-password-one");
});
