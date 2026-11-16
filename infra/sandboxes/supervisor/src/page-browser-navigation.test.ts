import { describe, expect, it } from "vitest";
import { allowPrivateBrowserHosts, navigableUrl } from "./page-browser-navigation.js";

describe("navigableUrl", () => {
  it.each([
    "http://localhost/",
    "http://localhost./",
    "https://app.localhost/",
    "http://printer.local/",
    "http://host.docker.internal/",
    "http://metadata.google.internal/latest/meta-data",
    "http://127.0.0.1/",
    "http://127.1.2.3:8080/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.10/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fd00:ec2::254]/",
    "http://[::ffff:127.0.0.1]/",
  ])("refuses %s", (url) => {
    expect(navigableUrl(url, false)).toBeUndefined();
  });

  it.each([
    "https://example.test/",
    "http://example.test/page?q=1",
    "https://bank.example/files/statement.pdf",
    "https://8.8.8.8/",
    "https://[2606:4700:4700::1111]/",
    "http://203.0.113.10/",
  ])("keeps %s", (url) => {
    expect(navigableUrl(url, false)).toBe(url);
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "chrome://settings",
    "https://user:fake-password@example.test/",
    "not a url",
  ])("refuses %s whatever the private-host setting is", (url) => {
    expect(navigableUrl(url, true)).toBeUndefined();
  });

  it("lets an operator open this machine's addresses on their own computer", () => {
    expect(navigableUrl("http://127.0.0.1:3000/", true)).toBe("http://127.0.0.1:3000/");
    expect(navigableUrl("http://host.docker.internal:45175/", true)).toBe(
      "http://host.docker.internal:45175/",
    );
  });

  // The owner's private-host opt-in covers the person's own services, never a cloud credential store.
  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/",
    "http://100.100.100.200/",
  ])("still refuses the metadata service %s when private hosts are allowed", (url) => {
    expect(navigableUrl(url, true)).toBeUndefined();
  });
});

describe("allowPrivateBrowserHosts", () => {
  it("is off unless the operator sets it", () => {
    expect(allowPrivateBrowserHosts({})).toBe(false);
    expect(allowPrivateBrowserHosts({ RAKAZO_BROWSER_ALLOW_PRIVATE_HOSTS: "" })).toBe(false);
    expect(allowPrivateBrowserHosts({ RAKAZO_BROWSER_ALLOW_PRIVATE_HOSTS: "true" })).toBe(false);
    expect(allowPrivateBrowserHosts({ RAKAZO_BROWSER_ALLOW_PRIVATE_HOSTS: "1" })).toBe(true);
  });
});
