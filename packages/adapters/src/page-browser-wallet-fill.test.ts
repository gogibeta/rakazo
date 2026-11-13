import { describe, expect, it } from "vitest";
import { PageBrowserSession } from "./page-browser-session.js";

const site = "https://wallet.example.test";
const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const phrase = "test test test test test test test test test test test junk";
const page = `<!doctype html><html><head><title>Import wallet</title></head><body>
  <input aria-label="Private key" type="password" />
  <input aria-label="Backup phrase" type="text" />
  <input aria-label="Email" type="email" />
  <textarea aria-label="Seed phrase"></textarea>
  <select aria-label="Network"><option>Ethereum</option></select>
</body></html>`;

function importSession(url = `${site}/import`) {
  const session = new PageBrowserSession(url, page);
  const refs = () => {
    const { elements } = session.snapshot();
    return (name: string) => elements.find((el) => el.name === name)!.ref;
  };
  return { session, ref: refs() };
}

const walletFill = (ref: string, text: string, origin = site) => ({
  kind: "fill" as const,
  ref,
  text,
  origin,
  field: "wallet" as const,
});

describe("in-process page browser wallet fill", () => {
  it("types a key into a password field and a phrase into a text field and a text area, and keeps them out of snapshots", () => {
    const { session, ref } = importSession();
    const result = session.act([
      walletFill(ref("Private key"), key),
      walletFill(ref("Backup phrase"), phrase),
      walletFill(ref("Seed phrase"), phrase),
    ]);
    expect(result).toMatchObject({ ok: true, completed: 3 });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(phrase);
    expect(JSON.stringify(session.snapshot())).not.toContain(key);
    expect(JSON.stringify(session.snapshot())).not.toContain(phrase);
  });

  it("refuses email fields, dropdowns, another site, and plain HTTP", () => {
    for (const target of ["Email", "Network"]) {
      const { session, ref } = importSession();
      const result = session.act([walletFill(ref(target), key)]);
      expect(result, target).toMatchObject({
        ok: false,
        completed: 0,
        uncertain: false,
        error:
          "A wallet key can only be typed into a password, text or telephone field, or a text area.",
      });
      expect(JSON.stringify(result), target).not.toContain(key);
      expect(JSON.stringify(session.snapshot()), target).not.toContain(key);
    }
    const other = importSession();
    const wrongSite = other.session.act([
      walletFill(other.ref("Private key"), key, "https://other.example.test"),
    ]);
    expect(wrongSite).toMatchObject({ ok: false, completed: 0 });
    expect(wrongSite.error).toMatch(/approved for/);
    const plain = importSession("http://wallet.example.test/import");
    const plainHttp = plain.session.act([walletFill(plain.ref("Private key"), key)]);
    expect(plainHttp).toMatchObject({ ok: false, completed: 0 });
    expect(plainHttp.error).toMatch(/only be filled on HTTPS/);
  });
});
