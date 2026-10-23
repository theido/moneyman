import { jest } from "@jest/globals";

const mockLoadInfo = jest.fn<() => Promise<void>>();
const mockLoadHeaderRow = jest.fn<() => Promise<void>>();
const mockGetRows =
  jest.fn<() => Promise<Array<{ get: (key: string) => unknown }>>>();
const mockJWT = jest.fn();
const mockSheet = {
  headerValues: ["hash", "doc_number", "pdf_link"],
  loadHeaderRow: mockLoadHeaderRow,
  getRows: mockGetRows,
};
const mockDoc = {
  loadInfo: mockLoadInfo,
  sheetsByTitle: { _moneyman: mockSheet },
};
const mockSpreadsheet = jest.fn(() => mockDoc);

jest.mock("google-spreadsheet", () => ({ GoogleSpreadsheet: mockSpreadsheet }));
jest.mock("google-auth-library", () => ({ JWT: mockJWT }));

import { getInvoiceHistory } from "./InvoiceHistory.js";
import { config } from "../../utils/tests.js";

function historyConfig() {
  const c = config();
  c.storage.googleSheets = {
    sheetId: "sheet-id",
    worksheetName: "_moneyman",
    serviceAccountEmail: "test@example.com",
    serviceAccountPrivateKey: "test-key",
  };
  return c;
}

function row(data: Record<string, unknown>) {
  return { get: (key: string) => data[key] };
}

describe("invoice history (read only)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSheet.headerValues = ["hash", "doc_number", "pdf_link"];
    mockLoadInfo.mockResolvedValue(undefined);
    mockLoadHeaderRow.mockResolvedValue(undefined);
    mockGetRows.mockResolvedValue([]);
  });

  it("loads only invoice mappings, including partial mappings and numeric document numbers", async () => {
    mockGetRows.mockResolvedValue([
      row({ hash: "existing", doc_number: 123, pdf_link: "https://pdf" }),
      row({ hash: "partial", doc_number: "456" }),
      row({ hash: "no-invoice" }),
      row({ doc_number: "no-hash" }),
    ]);
    const history = await getInvoiceHistory(historyConfig());
    expect(history).toEqual(
      new Map([
        ["existing", { doc_number: "123", pdf_link: "https://pdf" }],
        ["partial", { doc_number: "456", pdf_link: undefined }],
        ["no-invoice", { doc_number: undefined, pdf_link: undefined }],
      ]),
    );
    expect(mockJWT).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      }),
    );
    expect(mockGetRows).toHaveBeenCalledTimes(1);
  });

  it("does not treat missing persistence as an empty authoritative history", async () => {
    expect(await getInvoiceHistory(config())).toBeUndefined();
    expect(mockSpreadsheet).not.toHaveBeenCalled();
  });

  it("does not treat a sheet without invoice columns as an empty history", async () => {
    mockSheet.headerValues = ["hash", "description"];
    expect(await getInvoiceHistory(historyConfig())).toBeUndefined();
    expect(mockGetRows).not.toHaveBeenCalled();
  });

  it("propagates read failures rather than returning a misleading empty history", async () => {
    mockLoadInfo.mockRejectedValueOnce(new Error("read failed"));
    await expect(getInvoiceHistory(historyConfig())).rejects.toThrow(
      "read failed",
    );
  });

  it("rejects conflicting mappings instead of choosing an arbitrary invoice", async () => {
    mockGetRows.mockResolvedValue([
      row({ hash: "same", doc_number: "123", pdf_link: "https://pdf/123" }),
      row({ hash: "same", doc_number: "456", pdf_link: "https://pdf/456" }),
    ]);
    await expect(getInvoiceHistory(historyConfig())).rejects.toThrow(
      "Conflicting invoice mappings",
    );
  });
});
