import debug from "debug";
import assert from "node:assert/strict";
import test, { before, after, describe } from "node:test";
import { CompanyTypes, createScraper } from "israeli-bank-scrapers";
import { ScraperErrorTypes } from "israeli-bank-scrapers/lib/scrapers/errors.js";
import {
  createBrowser,
  createSecureBrowserContext,
} from "./scraper/browser.js";
import { createLogger } from "./utils/logger.js";
import { getExternalIp } from "./runnerMetadata.js";
import { scraperOptions } from "./scraper/index.js";
import { config } from "./config.js";

const logger = createLogger("test-scraper-access");

const firewallSettings = [
  ...["amex", "isracard"].flatMap((company) =>
    [
      "doubleclick.net",
      "googletagmanager.com",
      "google.com",
      "instagram.com",
    ].map((domain) => `${company} BLOCK ${domain}`),
  ),
];

config.options.scraping.domainTracking = true;
config.options.security.firewallSettings = firewallSettings;

debug.enable(
  "moneyman:browser,moneyman:test-scraper-access,moneyman:cloudflare-solver,moneyman:domain-rules,israeli-bank-scrapers:*",
);

describe("Sites access tests", () => {
  let browser: Awaited<ReturnType<typeof createBrowser>>;

  before(async () => {
    logger("Starting tests");
    logger("Connecting from: ", await getExternalIp());
    browser = await createBrowser();
  });

  after(async () => {
    await browser.close();
  });

  describe("scraper access", () => {
    for (const companyId of [
      CompanyTypes.amex,
      CompanyTypes.isracard,
    ] as const) {
      test(`Can start scraping ${companyId}`, async () => {
        const scraper = createScraper({
          companyId,
          startDate: new Date(),
          browserContext: await createSecureBrowserContext(browser, companyId),
          ...scraperOptions,
        });

        const result = await scraper.scrape({
          card6Digits: "123456",
          id: "123456789",
          password: "1234",
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.errorType, ScraperErrorTypes.InvalidPassword);
      });
    }
  });
});
