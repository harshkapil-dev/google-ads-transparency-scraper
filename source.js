import { domainToASCII } from "node:url";
import { proxyClient } from "./proxy.js";
import { requestJson, resultLimit, WorkerError } from "./upstream.js";

const origin = "https://adstransparency.google.com";
const regions = new Map([
  ["ALL", null], ["US", 2840], ["GB", 2826], ["CA", 2124], ["AU", 2036],
  ["DE", 2276], ["FR", 2250], ["IN", 2356],
]);
const advertiserPattern = /^AR\d{20}$/;
const creativePattern = /^CR\d{20}$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

export function parseInput(body) {
  const allowed = ["query", "region", "max_total_results"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new WorkerError(400, "Unknown input field");
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 253 || /[\x00-\x1f\x7f]/.test(query)) {
    throw new WorkerError(400, "Enter an advertiser name, bare domain, or advertiser ID");
  }
  if (query.includes("/") || query.includes("@") || query.includes("://")) {
    throw new WorkerError(400, "Enter a bare domain without a URL path or account details");
  }
  const region = body.region ?? "ALL";
  if (!regions.has(region)) throw new WorkerError(400, "Unsupported region");
  return { query, region, max_total_results: resultLimit(body.max_total_results ?? 20, 100) };
}

export function sourceReady() {
  return true;
}

function rowsFrom(response) {
  if (!response || typeof response !== "object" || Array.isArray(response) ||
      (response["1"] !== undefined && !Array.isArray(response["1"])) ||
      !Object.keys(response).every((key) => ["1", "2", "3", "4", "5"].includes(key))) {
    throw new WorkerError(502, "Google Ads Transparency returned an unexpected response");
  }
  return response["1"] || [];
}

async function rpc(method, payload, context) {
  const url = `${origin}/anji/_/rpc/SearchService/${method}`;
  const options = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ "f.req": JSON.stringify(payload) }),
  };
  try {
    return await requestJson(url, options, context.signal, { fetcher: context.fetcher });
  } catch (error) {
    if (!(error instanceof WorkerError) || ![502, 503, 504].includes(error.status)) throw error;
    const proxy = proxyClient(context.env || {});
    if (!proxy) throw error;
    try {
      return await requestJson(url, options, context.signal, { fetcher: proxy.fetcher, attempts: 2 });
    } finally { await proxy.close(); }
  }
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

async function lookupAdvertisers(query, region, context) {
  if (advertiserPattern.test(query.toUpperCase())) return [query.toUpperCase()];
  const response = await rpc("SearchSuggestions", {
    "1": query, "2": 10, "3": 10, ...(region && { "4": [region] }), "5": { "1": 1 },
  }, context);
  const matches = rowsFrom(response)
    .map((suggestion) => suggestion?.["1"])
    .filter((entry) => typeof entry?.["1"] === "string" && advertiserPattern.test(entry["2"]));
  const exact = matches.filter((entry) => normalizeName(entry["1"]) === normalizeName(query));
  return [...new Set((exact.length ? exact : matches.slice(0, 1)).map((entry) => entry["2"]))];
}

function timestamp(value) {
  if (typeof value?.["1"] !== "string" || !/^\d{1,12}$/.test(value["1"])) return null;
  const date = new Date(Number(value["1"]) * 1000 + Math.floor((value["2"] || 0) / 1e6));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toRow(item, region) {
  const advertiserId = item?.["1"];
  const creativeId = item?.["2"];
  if (!advertiserPattern.test(advertiserId) || !creativePattern.test(creativeId)) return null;
  const adUrl = new URL(`/advertiser/${advertiserId}/creative/${creativeId}`, origin);
  if (region !== "ALL") adUrl.searchParams.set("region", region);
  return {
    advertiser_id: advertiserId,
    advertiser_name: typeof item["12"] === "string" ? item["12"] : null,
    creative_id: creativeId,
    ad_url: adUrl.href,
    ad_format_code: Number.isInteger(item["4"]) ? item["4"] : null,
    first_shown_at: timestamp(item["6"]),
    last_shown_at: timestamp(item["7"]),
    advertiser_domain: typeof item["14"] === "string" ? item["14"] : null,
    region,
  };
}

export async function collect(input, context) {
  const { query, max_total_results: limit } = input;
  const region = regions.get(input.region);
  const domain = domainToASCII(query).toLowerCase();
  const byDomain = domainPattern.test(domain);
  let { advertiserIds, cursor, pages = 0 } = context.job;
  const rows = [...context.job.results];
  const seen = new Set(rows.map((row) => `${row.advertiser_id}:${row.creative_id}`));
  if (!byDomain && !advertiserIds) {
    advertiserIds = await lookupAdvertisers(query, region, context);
    if (!advertiserIds.length) return [];
    await context.checkpoint({ advertiserIds });
  }

  while (rows.length < limit && pages < 6) {
    const response = await rpc("SearchCreatives", {
      "2": Math.min(40, limit - rows.length),
      "3": {
        ...(region && { "8": [region] }),
        "12": { "1": byDomain ? domain : "", "2": true },
        ...(!byDomain && { "13": { "1": advertiserIds } }),
      },
      ...(cursor && { "4": cursor }),
      "7": { "1": 1, "2": 0, "3": 2356 },
    }, context);
    const items = rowsFrom(response);
    let invalid = 0;
    for (const item of items) {
      const row = toRow(item, input.region);
      if (!row) {
        invalid += 1;
        continue;
      }
      const key = `${row.advertiser_id}:${row.creative_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      if (rows.length === limit) break;
    }
    if (invalid && invalid === items.length) throw new WorkerError(502, "Google Ads Transparency returned unrecognized creative records");
    const next = typeof response["2"] === "string" && response["2"].length <= 2048 ? response["2"] : null;
    pages += 1;
    if (!next || next === cursor || !items.length || rows.length === limit || pages === 6) break;
    cursor = next;
    await context.checkpoint({ results: [...rows], cursor, pages });
  }
  return rows;
}
