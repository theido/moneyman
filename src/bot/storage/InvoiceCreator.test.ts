import { jest } from "@jest/globals";

const mockSend = jest.fn(() => Promise.resolve(undefined));
const mockSendError = jest.fn(() => Promise.resolve(undefined));

jest.mock("../notifier.js", () => ({
  __esModule: true,
  send: mockSend,
  sendError: mockSendError,
}));

import { InvoiceCreator } from "./InvoiceCreator.js";
import { config, transactionRow } from "../../utils/tests.js";

describe("InvoiceCreator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("includes the configured customer CRN in the EZcount request", async () => {
    const mockFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    globalThis.fetch = mockFetch;

    const invoiceConfig = config();
    invoiceConfig.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "api-key",
      customerCrn: "515151515",
    };

    await new InvoiceCreator(invoiceConfig).createInvoiceForTransaction(
      transactionRow({ description: "Insurance vendor" }),
    );

    const [, request] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      customer_crn: "515151515",
    });
  });

  it("uses the CRN configured for the matching vendor", async () => {
    const mockFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    globalThis.fetch = mockFetch;

    const invoiceConfig = config();
    invoiceConfig.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "api-key",
      customerCrnByVendor: { הראל: "515151515" },
    };

    await new InvoiceCreator(invoiceConfig).createInvoiceForTransaction(
      transactionRow({ description: "הראל ביטוח" }),
    );

    const [, request] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      customer_crn: "515151515",
    });
  });

  it("sends invoice success and failure notifications", async () => {
    const mockFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ pdf_link: "https://pdf", doc_number: "123" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    globalThis.fetch = mockFetch;

    const invoiceConfig = config();
    invoiceConfig.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "api-key",
    };

    const creator = new InvoiceCreator(invoiceConfig);
    await creator.createInvoicesForTransactions([
      transactionRow({ description: "הראל ביטוח" }),
      transactionRow({ description: "כלל ביטוח" }),
    ]);

    expect(mockSendError).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining("✅ Invoice created for הראל ביטוח"),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining("https://pdf"),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining(
        "🧾 InvoiceCreator finished: 1/2 created, 1 failed",
      ),
    );
  });

  it("maps every configured vendor to its CRN without making a real request", async () => {
    const mockFetch = jest
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      );
    globalThis.fetch = mockFetch;

    const vendorCrns = {
      ילין: "513611509",
      אלטשולר: "513173393",
      מור: "514956465",
      אנליסט: "511880460",
      מגדל: "520004896",
      כלל: "520024647",
      הראל: "520004078",
      מנורה: "520042540",
      פניקס: "520023185",
    };
    const invoiceConfig = config();
    invoiceConfig.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "api-key",
      customerCrnByVendor: vendorCrns,
    };
    const creator = new InvoiceCreator(invoiceConfig);

    for (const [vendor, customerCrn] of Object.entries(vendorCrns)) {
      await creator.createInvoiceForTransaction(
        transactionRow({ description: `${vendor} transaction` }),
      );
      const [, request] = mockFetch.mock.calls.at(-1)!;
      expect(JSON.parse(String(request?.body))).toMatchObject({
        customer_crn: customerCrn,
      });
    }

    expect(mockFetch).toHaveBeenCalledTimes(Object.keys(vendorCrns).length);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/api/createDoc",
      expect.anything(),
    );
  });
});
