import assert from "node:assert";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import type { MoneymanConfig } from "../../config.js";

export interface InvoiceMapping {
  pdf_link?: string;
  doc_number?: string;
}

/**
 * Reload durable invoice mappings for every run (including ephemeral Docker/GH
 * runners). This adapter never changes headers, rows, or the Sheets writer.
 * undefined means history is unavailable, not that every invoice is new.
 */
export async function getInvoiceHistory(
  config: MoneymanConfig,
): Promise<Map<string, InvoiceMapping> | undefined> {
  const settings = config.storage.googleSheets;
  if (!settings) return undefined;
  const auth = new JWT({
    email: settings.serviceAccountEmail,
    key: settings.serviceAccountPrivateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const doc = new GoogleSpreadsheet(settings.sheetId, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[settings.worksheetName || "_moneyman"];
  assert(sheet, "Invoice history worksheet not found");
  await sheet.loadHeaderRow();
  if (
    !["hash", "doc_number", "pdf_link"].every((h) =>
      sheet.headerValues.includes(h),
    )
  ) {
    return undefined;
  }
  const history = new Map<string, InvoiceMapping>();
  const rows = await sheet.getRows();
  for (const row of rows) {
    const hash = String(row.get("hash") ?? "");
    const doc_number = String(row.get("doc_number") ?? "") || undefined;
    const pdf_link = String(row.get("pdf_link") ?? "") || undefined;
    // Keep bare transaction hashes too: a saved row without invoice metadata
    // cannot prove whether EZcount has already created its invoice.
    if (!hash) continue;
    const previous = history.get(hash);
    if (
      previous &&
      ((previous.doc_number &&
        doc_number &&
        previous.doc_number !== doc_number) ||
        (previous.pdf_link && pdf_link && previous.pdf_link !== pdf_link))
    ) {
      throw new Error("Conflicting invoice mappings in invoice history");
    }
    history.set(hash, {
      doc_number: doc_number || previous?.doc_number,
      pdf_link: pdf_link || previous?.pdf_link,
    });
  }
  return history;
}
