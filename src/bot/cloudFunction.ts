import { runWithStorage } from "./index.js";
import { RunnerHooks } from "../types.js";

// Import the runScraper function from the main entry point
import { runScraper } from "../index.js";

type HttpRes = { status: (code: number) => { send: (msg: string) => void } };

// Google Cloud Function HTTP handler
export const scheduledScrape = async (_req: unknown, res: HttpRes) => {
  try {
    await runWithStorage(runScraper);
    res.status(200).send("Scrape completed");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).send("Error: " + msg);
  }
};
