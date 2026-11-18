# Google Ads Transparency

Search Google's public Ads Transparency Center by advertiser name, bare website domain, or advertiser ID. Select an ad delivery region and request up to 100 creatives. Rows include public creative URLs, advertiser names, source format codes, and the first and last shown timestamps where Google provides them.

The worker uses the same anonymous search and pagination requests as the public interface. For advertiser names, it searches exact normalized matches when available and otherwise uses the top suggestion. Domain searches are sent as filters and the worker does not visit the submitted domains.

`npm ci` installs the locked dependencies. `npm test` runs deterministic contract and extraction tests. For a local live run, set `SCRAPER_QUEUE_REDIS_URL` to a development Redis instance and start the worker with `npm start`. The replayable request is in `pulldata.input.json`. Job results are retained for 24 hours. Active jobs resume from the last saved page when a caller polls after a worker interruption.

Marketplace deployments use the dedicated Postgres database assigned by Pulldata for job state. Local runs can use Redis or a Postgres database with the schema in `job-store.sql`.
