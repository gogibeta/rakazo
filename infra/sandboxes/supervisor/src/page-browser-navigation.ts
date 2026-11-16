import { isCloudMetadataHost, isNonPublicHostname } from "@rakazo/contracts/network-host";

/**
 * Whether this deployment lets a bot open this machine or its own network in the page browser.
 * Off unless the operator says so: a computer's browser sits on the computer's network, where
 * those addresses are the host, the LAN, and the server's own services.
 */
export function allowPrivateBrowserHosts(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAKAZO_BROWSER_ALLOW_PRIVATE_HOSTS === "1";
}

/**
 * The URL a navigate request may open, or undefined when it may not.
 *
 * A cloud metadata service is refused whoever the operator is, as it is for bot credentials. The
 * in-computer page browser checks the same rules before it opens anything; this check runs first,
 * so the caller learns the destination was refused before a command reaches the computer, and a
 * computer still on an older image does not open it either.
 */
export function navigableUrl(
  value: string,
  allowPrivate: boolean = allowPrivateBrowserHosts(),
): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  if (isCloudMetadataHost(url.hostname)) return undefined;
  if (!allowPrivate && isNonPublicHostname(url.hostname)) return undefined;
  return value;
}
