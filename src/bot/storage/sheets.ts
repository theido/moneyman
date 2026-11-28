import assert from "node:assert";
import { createLogger } from "../../utils/logger.js";
import {
  GoogleSpreadsheet,
  GoogleSpreadsheetWorksheet,
} from "google-spreadsheet";
import { JWT } from "google-auth-library";
import type { TransactionRow, TransactionStorage } from "../../types.js";
import { sendError } from "../notifier.js";
import { sendDeprecationMessage } from "../deprecationManager.js";
import { createSaveStats } from "../saveStats.js";
import { tableRow } from "../transactionTableRow.js";
import type { MoneymanConfig } from "../../config.js";

const logger = createLogger("GoogleSheetsStorage");

export class GoogleSheetsStorage implements TransactionStorage {
  private worksheetName: string;

  constructor(private config: MoneymanConfig) {
    this.worksheetName =
      this.config.storage.googleSheets?.worksheetName || "_moneyman";
  }
  canSave() {
    return Boolean(this.config.storage.googleSheets);
  }

  async saveTransactions(
    txns: Array<TransactionRow>,
    onProgress: (status: string) => Promise<void>,
  ) {
    const [doc] = await Promise.all([this.getDoc(), onProgress("Getting doc")]);

    await onProgress(`Getting sheet ${this.worksheetName}`);
    const sheet = doc.sheetsByTitle[this.worksheetName];
    assert(sheet, `Sheet ${this.worksheetName} not found`);

    const [headerRowResult] = await Promise.allSettled([
      sheet.loadHeaderRow(),
      onProgress(`Loading header row`),
    ]);

    if (headerRowResult.status === "rejected") {
      logger("Error loading header row", headerRowResult.reason);
      sendError(headerRowResult.reason, "GoogleSheetsStorage::loadHeaderRow");
      await onProgress(`Loading header row failed: ${headerRowResult.reason}`);
      throw new Error(`Failed to load header row: ${headerRowResult.reason}`);
    }
    logger(`Loaded header row: ${sheet.headerValues}`);
    const invoiceHeaders = ["pdf_link", "doc_number"] as const;
    const missingInvoiceHeaders = invoiceHeaders.filter(
      (header) => !sheet.headerValues.includes(header),
    );
    if (missingInvoiceHeaders.length > 0) {
      const requiredColumnCount =
        sheet.headerValues.length + missingInvoiceHeaders.length;
      if (requiredColumnCount > sheet.columnCount) {
        await sheet.resize({
          rowCount: sheet.rowCount,
          columnCount: requiredColumnCount,
        });
      }
      await sheet.setHeaderRow([
        ...sheet.headerValues,
        ...missingInvoiceHeaders,
      ]);
    }

    const existingHashes = await this.loadHashes(sheet, onProgress);

    const invoicedExistingTxns = txns.filter(
      (tx) =>
        (tx.pdf_link || tx.doc_number) &&
        (existingHashes.has(tx.uniqueId) || existingHashes.has(tx.hash)),
    );
    if (invoicedExistingTxns.length > 0) {
      const txById = new Map<string, TransactionRow>();
      for (const tx of invoicedExistingTxns) {
        txById.set(tx.uniqueId, tx);
        txById.set(tx.hash, tx);
      }
      for (const row of await sheet.getRows()) {
        const tx = txById.get(String(row.get("hash") ?? ""));
        if (!tx) continue;
        let changed = false;
        for (const field of invoiceHeaders) {
          const value = tx[field];
          if (value && row.get(field) !== value) {
            row.set(field, value);
            changed = true;
          }
        }
        if (changed) await row.save();
      }
    }

    const stats = createSaveStats("Google Sheets", this.worksheetName, txns, {
      highlightedTransactions: {
        Added: [] as Array<TransactionRow>,
      },
    });

    const newTxns = txns.filter((tx) => {
      if (this.config.options.scraping.transactionHashType === "moneyman") {
        // Use the new uniqueId as the unique identifier for the transactions if the hash type is moneyman
        if (existingHashes.has(tx.uniqueId)) {
          stats.existing++;
          return false;
        }
      }

      if (existingHashes.has(tx.hash)) {
        if (this.config.options.scraping.transactionHashType === "moneyman") {
          logger(`Skipping, old hash ${tx.hash} is already in the sheet`);
        }

        stats.existing++;
        return false;
      }

      return true;
    });

    const hasRawColumn = sheet.headerValues.includes("raw");
    const rows = newTxns.map((tx) =>
      tableRow(
        tx,
        hasRawColumn,
        this.config.options.scraping.transactionHashType,
      ),
    );
    if (rows.length) {
      stats.highlightedTransactions.Added.push(...newTxns);
      stats.added = rows.length;
      const [addRowsResult] = await Promise.allSettled([
        sheet.addRows(
          rows.map((row) => ({ ...row, amount: row.amount ?? "" })),
        ),
        onProgress(`Saving ${rows.length} rows`),
      ]);
      if (this.config.options.scraping.transactionHashType !== "moneyman") {
        sendDeprecationMessage(
          "hashFiledChange",
          this.config.options.scraping.hiddenDeprecations,
        );
      }

      if (addRowsResult.status === "rejected") {
        logger("Error saving rows", addRowsResult.reason);
        sendError(
          addRowsResult.reason,
          "GoogleSheetsStorage::saveTransactions",
        );
        await onProgress(
          `recovering stats after saving failed: ${addRowsResult.reason}`,
        );

        try {
          const hashes = await this.loadHashes(sheet, onProgress);
          const notSaved = newTxns.filter(
            ({ hash, uniqueId }) => !hashes.has(hash) && !hashes.has(uniqueId),
          );
          stats.added -= notSaved.length;
          stats.otherSkipped = notSaved.length;
        } catch (e) {
          logger("Error loading hashes", e);
          sendError(e, "GoogleSheetsStorage::saveTransactions");
        }
      }
    }

    return stats;
  }

  async getInvoiceTransactionIds(): Promise<Set<string>> {
    const doc = await this.getDoc();
    const sheet = doc.sheetsByTitle[this.worksheetName];
    assert(sheet, "Sheet " + this.worksheetName + " not found");
    await sheet.loadHeaderRow();

    const rows = await sheet.getRows();
    const ids = new Set<string>();
    for (const row of rows) {
      const pdfLink = row.get("pdf_link" as never);
      const docNumber = row.get("doc_number" as never);
      let raw: {
        uniqueId?: string;
        hash?: string;
        pdf_link?: string;
        doc_number?: string;
      } = {};
      const rawValue = row.get("raw" as never);
      if (typeof rawValue === "string" && rawValue) {
        try {
          const parsed: unknown = JSON.parse(rawValue);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            raw = parsed;
          }
        } catch {
          // Ignore malformed raw values and use the dedicated columns.
        }
      }

      if ((pdfLink || raw.pdf_link) && (docNumber || raw.doc_number)) {
        const id = row.get("hash" as never);
        if (typeof id === "string" && id) ids.add(id);
        if (raw.uniqueId) ids.add(raw.uniqueId);
        if (raw.hash) ids.add(raw.hash);
      }
    }
    return ids;
  }

  private async getDoc() {
    const googleSheetsConfig = this.config.storage.googleSheets;
    assert(googleSheetsConfig, "Google Sheets configuration not found");

    const authClient = new JWT({
      email: googleSheetsConfig.serviceAccountEmail,
      key: googleSheetsConfig.serviceAccountPrivateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const doc = new GoogleSpreadsheet(googleSheetsConfig.sheetId, authClient);
    await doc.loadInfo();
    return doc;
  }

  /**
   * Load hashes from the "hash" column, assuming the first row is a header row
   */
  private async loadHashes(
    sheet: GoogleSpreadsheetWorksheet,
    onProgress: (status: string) => Promise<void>,
  ) {
    const column = sheet.headerValues.indexOf("hash");
    assert(column !== -1, "Hash column not found");
    assert(column < 26, "Currently only supports single letter columns");

    const columnLetter = String.fromCharCode(65 + column);
    const range = `${columnLetter}2:${columnLetter}`;

    const [columns] = await Promise.allSettled([
      sheet.getCellsInRange(range, {
        majorDimension: "COLUMNS",
      }) as Promise<string[][]>,
      onProgress(`Loading hashes (${range})`),
    ]);

    if (columns.status === "rejected") {
      logger("Failed to load hashes", columns.reason);
      await onProgress(`Loading hashes failed: ${columns.reason}`);
      throw new Error(`Loading hashes failed: ${columns.reason}`);
    }

    return Array.isArray(columns.value)
      ? new Set(columns.value[0])
      : new Set<string>();
  }
}
