import { GoogleSheetsStorage } from "./sheets.js";
import {
  GoogleSpreadsheet,
  GoogleSpreadsheetWorksheet,
} from "google-spreadsheet";
import { mock, mockClear } from "jest-mock-extended";
import { config, transactionRow } from "../../utils/tests.js";
import type { MoneymanConfig } from "../../config.js";
import { LoggingOptionsSchema } from "../../config.schema.js";

// Create mocks at top level
const mockSheet = mock<GoogleSpreadsheetWorksheet>({
  headerValues: ["date", "amount", "description", "hash"],
});
const mockDoc = mock<GoogleSpreadsheet>({
  sheetsByTitle: { _moneyman: mockSheet },
});

// Mock the google-spreadsheet module
jest.mock("google-spreadsheet", () => ({
  GoogleSpreadsheet: jest.fn(() => mockDoc),
}));
jest.mock("google-auth-library");

// Mock logger
jest.mock("../../utils/logger.js", () => ({
  createLogger: () => jest.fn(),
}));

// Mock other dependencies
jest.mock("../notifier.js", () => ({
  sendError: jest.fn(),
}));

jest.mock("../saveStats.js", () => ({
  createSaveStats: jest.fn().mockReturnValue({
    existing: 0,
    added: 0,
    highlightedTransactions: { Added: [] },
  }),
}));

jest.mock("../transactionTableRow.js", () => ({
  tableRow: jest.fn().mockReturnValue({}),
}));

describe("GoogleSheetsStorage", () => {
  let storage: GoogleSheetsStorage;

  beforeEach(() => {
    const mockConfig: MoneymanConfig = config();
    mockConfig.storage.googleSheets = {
      serviceAccountPrivateKey: "test-key",
      serviceAccountEmail: "test@example.com",
      sheetId: "test-sheet-id",
      worksheetName: "_moneyman",
    };

    storage = new GoogleSheetsStorage(mockConfig);

    // Setup default mock implementations
    mockSheet.getCellsInRange.mockResolvedValue([[]]);
    mockSheet.addRows.mockResolvedValue([]);
    mockSheet.loadHeaderRow.mockResolvedValue(undefined);
    mockDoc.loadInfo.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
    mockClear(mockDoc);
    mockClear(mockSheet);
  });

  describe("error handling for Google API operations", () => {
    it("should throw error when doc.loadInfo fails", async () => {
      const errorMessage =
        "Google API error - [503] The service is currently unavailable";
      mockDoc.loadInfo.mockRejectedValue(new Error(errorMessage));

      await expect((storage as any).getDoc()).rejects.toThrow(errorMessage);
      expect(mockDoc.loadInfo).toHaveBeenCalledTimes(1);
    });

    it("should throw error when sheet.addRows fails", async () => {
      mockDoc.loadInfo.mockResolvedValue(undefined);
      mockSheet.loadHeaderRow.mockResolvedValue(undefined);

      const errorMessage =
        "Google API error - [503] The service is currently unavailable";
      mockSheet.addRows.mockRejectedValue(new Error(errorMessage));

      const mockTxn = transactionRow({
        account: "test-account",
        hash: "test-hash",
        uniqueId: "test-unique-id",
      });

      // The function should not throw but handle error internally
      const result = await storage.saveTransactions([mockTxn], async () => {});

      expect(mockSheet.addRows).toHaveBeenCalledTimes(1);
      // Check that getCellsInRange was called again to reload hashes after error
      expect(mockSheet.getCellsInRange).toHaveBeenCalledTimes(2);
      expect(result.otherSkipped).toBe(1);
      expect(result.added).toBe(0);
    });

    it("should throw error when sheet.loadHeaderRow fails", async () => {
      mockDoc.loadInfo.mockResolvedValue(undefined);

      const errorMessage =
        "Google API error - [503] The service is currently unavailable";
      mockSheet.loadHeaderRow.mockRejectedValue(new Error(errorMessage));

      const mockTxn = transactionRow({
        account: "test-account",
        hash: "test-hash",
        uniqueId: "test-unique-id",
      });

      await expect(
        storage.saveTransactions([mockTxn], async () => {}),
      ).rejects.toThrow(errorMessage);

      expect(mockSheet.loadHeaderRow).toHaveBeenCalledTimes(1);
    });

    it("should throw error when sheet.getCellsInRange fails", async () => {
      mockDoc.loadInfo.mockResolvedValue(undefined);
      mockSheet.loadHeaderRow.mockResolvedValue(undefined);

      const errorMessage =
        "Google API error - [503] The service is currently unavailable";
      mockSheet.getCellsInRange.mockRejectedValue(new Error(errorMessage));

      const mockTxn = transactionRow({
        account: "test-account",
        hash: "test-hash",
        uniqueId: "test-unique-id",
      });

      await expect(
        storage.saveTransactions([mockTxn], async () => {}),
      ).rejects.toThrow(errorMessage);

      expect(mockSheet.getCellsInRange).toHaveBeenCalledTimes(1);
    });

    it("should handle any error type without retrying", async () => {
      const errorTypes = [
        "Network error",
        "Authentication failed",
        "Invalid request",
        "503 Service Unavailable",
      ];

      for (const errorMessage of errorTypes) {
        mockDoc.loadInfo.mockRejectedValue(new Error(errorMessage));

        await expect((storage as any).getDoc()).rejects.toThrow(errorMessage);
        expect(mockDoc.loadInfo).toHaveBeenCalledTimes(1);

        mockDoc.loadInfo.mockClear();
      }
    });
  });

  describe("canSave", () => {
    it("should return false when GOOGLE_SHEET_ID is missing", () => {
      const configWithoutGoogleSheets: MoneymanConfig = {
        accounts: [],
        storage: {},
        options: {
          scraping: {
            daysBack: 10,
            futureMonths: 1,
            transactionHashType: "",
            additionalTransactionInfo: false,
            includeRawTransaction: false,
            hiddenDeprecations: [],
            maxParallelScrapers: 1,
            domainTracking: false,
          },
          security: {
            blockByDefault: false,
          },
          notifications: {},
          logging: LoggingOptionsSchema.parse({}),
        },
      };

      const newStorage = new GoogleSheetsStorage(configWithoutGoogleSheets);
      expect(newStorage.canSave()).toBe(false);
    });
  });

  it("loads transaction IDs that already have an invoice", async () => {
    (mockSheet as any).headerValues = ["hash", "pdf_link", "doc_number"];
    const get = jest.fn(
      (key: string) =>
        ({
          hash: "already-invoiced",
          pdf_link: "https://files.example/invoice.pdf",
          doc_number: "30241",
        })[key],
    );
    mockSheet.getRows.mockResolvedValue([{ get } as never]);

    await expect(storage.getInvoiceTransactionIds()).resolves.toEqual(
      new Set(["already-invoiced"]),
    );
  });

  it("does not treat partial invoice metadata as a completed invoice", async () => {
    (mockSheet as any).headerValues = ["hash", "pdf_link", "doc_number"];
    mockSheet.getRows.mockResolvedValue([
      {
        get: (key: string) =>
          ({ hash: "partial-invoice", doc_number: "30241" })[key],
      } as never,
    ]);

    await expect(storage.getInvoiceTransactionIds()).resolves.toEqual(
      new Set(),
    );
  });

  it("ignores raw cells that contain JSON without transaction fields", async () => {
    (mockSheet as any).headerValues = ["hash", "raw"];
    mockSheet.getRows.mockResolvedValue([
      {
        get: (key: string) => ({ hash: "old-hash", raw: "null" })[key],
      } as never,
    ]);

    await expect(storage.getInvoiceTransactionIds()).resolves.toEqual(
      new Set(),
    );
  });

  it("saves invoice metadata onto a transaction already in the sheet", async () => {
    (mockSheet as any).headerValues = ["hash", "pdf_link", "doc_number"];
    mockSheet.getCellsInRange.mockResolvedValue([["old-hash"]]);
    const savedRow: Record<string, string> = { hash: "old-hash" };
    mockSheet.getRows.mockResolvedValue([
      {
        get: (key: string) => savedRow[key],
        set: (key: string, value: string) => {
          savedRow[key] = value;
        },
        save: async () => {},
      } as never,
    ]);

    await storage.saveTransactions(
      [
        transactionRow({
          hash: "old-hash",
          uniqueId: "new-id",
          pdf_link: "https://files.example/invoice.pdf",
          doc_number: "30241",
        }),
      ],
      async () => {},
    );

    expect(savedRow).toEqual({
      hash: "old-hash",
      pdf_link: "https://files.example/invoice.pdf",
      doc_number: "30241",
    });
    expect(mockSheet.addRows).not.toHaveBeenCalled();
  });

  it("makes room for invoice columns on a sheet without spare columns", async () => {
    (mockSheet as any).headerValues = ["hash"];
    (mockSheet as any).columnCount = 1;
    mockSheet.setHeaderRow.mockImplementation(async (headers) => {
      if (headers.length > mockSheet.columnCount) {
        throw new Error("Sheet is not large enough");
      }
      (mockSheet as any).headerValues = headers;
    });
    mockSheet.resize.mockImplementation(async ({ columnCount }) => {
      (mockSheet as any).columnCount = columnCount;
    });

    await storage.saveTransactions([], async () => {});

    expect(mockSheet.headerValues).toEqual(["hash", "pdf_link", "doc_number"]);
  });
});
