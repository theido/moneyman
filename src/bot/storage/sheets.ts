import assert from "node:assert";
import { createLogger } from "../../utils/logger.js";
import {
  GoogleSpreadsheet,
  GoogleSpreadsheetWorksheet,
} from "google-spreadsheet";
import { JWT } from "google-auth-library";
import type { TransactionRow, TransactionStorage } from "../../types.js";
import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";
import { sendError } from "../notifier.js";
import { sendDeprecationMessage } from "../deprecationManager.js";
import { createSaveStats } from "../saveStats.js";
import { tableRow, TableHeaders } from "../transactionTableRow.js";
import type { MoneymanConfig } from "../../config.js";
import { parse } from "date-fns";

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

    const existingHashes = await this.loadHashes(sheet, onProgress);

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

        // To avoid double counting, skip if the new hash is already in the sheet
        if (!existingHashes.has(tx.uniqueId)) {
          stats.existing++;
        }

        return false;
      }

      return tx.status !== TransactionStatuses.Pending;
    });

    const hasRawColumn = sheet.headerValues.includes("raw");
    const rows = newTxns.map((tx) => tableRow(tx, hasRawColumn));
    if (rows.length) {
      stats.highlightedTransactions.Added.push(...newTxns);
      stats.added = rows.length;
      const [addRowsResult] = await Promise.allSettled([
        sheet.addRows(rows),
        onProgress(`Saving ${rows.length} rows`),
      ]);
      if (this.config.options.scraping.transactionHashType !== "moneyman") {
        sendDeprecationMessage("hashFiledChange");
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

  /**
   * Get all transactions from the Google Sheet for a specific month and year.
   * Returns transactions with date, amount, description, category, and account.
   */
  async getTransactionsForMonth(
    year: number,
    month: number,
  ): Promise<SheetTransaction[]> {
    const [doc] = await Promise.all([this.getDoc()]);

    const sheet = doc.sheetsByTitle[this.worksheetName];
    assert(sheet, `Sheet ${this.worksheetName} not found`);

    await sheet.loadHeaderRow();
    logger(`Loaded header row: ${sheet.headerValues}`);

    const rows = await sheet.getRows();
    logger(`Loaded ${rows.length} rows from sheet`);

    const transactions: SheetTransaction[] = [];

    for (const row of rows) {
      const dateStr = row.get("date");
      if (!dateStr) continue;

      // Parse date in dd/MM/yyyy format
      const date = parse(dateStr, "dd/MM/yyyy", new Date());
      if (isNaN(date.getTime())) {
        logger(`Invalid date: ${dateStr}`);
        continue;
      }

      // Filter by month and year
      if (date.getFullYear() !== year || date.getMonth() + 1 !== month) {
        continue;
      }

      const amount = parseFloat(row.get("amount") || "0");
      if (isNaN(amount)) {
        logger(`Invalid amount for row with date ${dateStr}`);
        continue;
      }

      transactions.push({
        date,
        amount,
        description: row.get("description") || "",
        category: row.get("category") || "",
        account: row.get("account") || "",
        memo: row.get("memo") || "",
      });
    }

    logger(`Found ${transactions.length} transactions for ${month}/${year}`);
    return transactions;
  }
}

export interface SheetTransaction {
  date: Date;
  amount: number;
  description: string;
  category: string;
  account: string;
  memo: string;
}
