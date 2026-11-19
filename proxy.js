import { fetch as undiciFetch, ProxyAgent } from "undici";
import { WorkerError } from "./upstream.js";

export function proxyClient(env) {
  const { WEBSHARE_PROXY_DOMAIN: host, WEBSHARE_PROXY_PORT: port,
    WEBSHARE_PROXY_USERNAME: user, WEBSHARE_PROXY_PASSWORD: password } = env;
  if (![host, port, user, password].some(Boolean)) return null;
  if (![host, port, user, password].every(Boolean) ||
      !/^[a-z0-9.-]+$/i.test(host) || !/^\d{1,5}$/.test(port) ||
      Number(port) < 1 || Number(port) > 65535) {
    throw new WorkerError(503, "The Ads proxy is not configured correctly");
  }
  const url = new URL(`http://${host}:${port}`);
  url.username = user;
  url.password = password;
  const dispatcher = new ProxyAgent(url.href);
  return {
    fetcher: (target, options) => undiciFetch(target, { ...options, dispatcher }),
    close: () => dispatcher.close(),
  };
}
