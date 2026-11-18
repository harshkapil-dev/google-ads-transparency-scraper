const advertiser = "AR12345678901234567890";
const rows = Array.from({ length: 3 }, (_, index) => ({
  "1": advertiser,
  "2": `CR${String(index + 1).padStart(20, "0")}`,
  "4": 1,
  "6": { "1": "1741564800", "2": 0 },
  "7": { "1": "1741564801", "2": 0 },
  "12": "Example Advertiser",
  "14": "example.com",
}));

export function createFixture() {
  return {
    env: {},
    fetcher: async (url, { body }) => {
      const request = JSON.parse(body.get("f.req"));
      if (url.endsWith("/SearchSuggestions")) {
        return Response.json({ "1": [{ "1": { "1": "Example Advertiser", "2": advertiser } }] });
      }
      const domain = request["3"]["12"]["1"];
      if (domain === "denied.example") return new Response("private upstream details", { status: 403 });
      if (domain === "missing.example") return Response.json({});
      if (request["4"]) return Response.json({ "1": [rows[0], ...rows.slice(1)] });
      return Response.json({ "1": [rows[0], rows[0]], "2": "next-page" });
    },
  };
}
