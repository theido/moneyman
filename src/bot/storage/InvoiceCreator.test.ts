import { jest } from "@jest/globals";

const mockSend = jest.fn(() => Promise.resolve(undefined));
const mockSendError = jest.fn(() => Promise.resolve(undefined));

jest.mock("../notifier.js", () => ({
  __esModule: true,
  send: mockSend,
  sendError: mockSendError,
}));

const mockGetInvoiceHistory =
  jest.fn<
    () => Promise<
      Map<string, { pdf_link?: string; doc_number?: string }> | undefined
    >
  >();
jest.mock("./InvoiceHistory.js", () => ({
  getInvoiceHistory: mockGetInvoiceHistory,
}));

import { InvoiceCreator } from "./InvoiceCreator.js";
import { config, transactionRow } from "../../utils/tests.js";

describe("InvoiceCreator", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSend.mockResolvedValue(undefined);
    mockSendError.mockResolvedValue(undefined);
    mockGetInvoiceHistory.mockResolvedValue(new Map());
  });

  it("preserves existing invoice mappings without sending another success", async () => {
    const invoiceConfig = config();
    invoiceConfig.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          pdf_link: "https://pdf",
          doc_number: "123",
        }),
      ),
    );
    const txn = transactionRow({ pdf_link: "https://pdf", doc_number: "123" });
    await new InvoiceCreator(invoiceConfig).createInvoicesForTransactions([
      txn,
    ]);
    expect(txn).toMatchObject({ pdf_link: "https://pdf", doc_number: "123" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      "🧾 InvoiceCreator finished: 0/1 newly recorded, 1 existing, 0 failed",
    );
  });

  it("loads prior invoice mappings on each fresh run, preserving storage metadata", async () => {
    const invoiceConfig = config();
    invoiceConfig.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    mockGetInvoiceHistory.mockResolvedValue(
      new Map([["unique-1", { pdf_link: "https://pdf", doc_number: "123" }]]),
    );
    globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://pdf",
            doc_number: "123",
          }),
        ),
    );
    for (let run = 0; run < 2; run++) {
      const txn = transactionRow({});
      await new InvoiceCreator(invoiceConfig).createInvoicesForTransactions([
        txn,
      ]);
      expect(txn).toMatchObject({ pdf_link: "https://pdf", doc_number: "123" });
    }
    expect(mockGetInvoiceHistory).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith(
      "🧾 InvoiceCreator finished: 0/1 newly recorded, 1 existing, 0 failed",
    );
  });

  it("rejects an empty transaction_id before contacting EZcount", async () => {
    const c = config();
    c.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          pdf_link: "https://pdf",
          doc_number: "123",
        }),
      ),
    );
    await expect(
      new InvoiceCreator(c).createInvoiceForTransaction(
        transactionRow({ uniqueId: "" }),
      ),
    ).rejects.toThrow("Invoice transaction_id is required");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects EZcount business errors under HTTP 200", async () => {
    const invoiceConfig = config();
    invoiceConfig.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ errNum: 1, errMsg: "api key is malformatted" }),
        ),
      );
    await expect(
      new InvoiceCreator(invoiceConfig).createInvoiceForTransaction(
        transactionRow({}),
      ),
    ).rejects.toThrow("EZcount error 1");
  });

  it("does not count notification failures as invoice failures or stop the batch", async () => {
    const invoiceConfig = config();
    invoiceConfig.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://pdf",
            doc_number: "123",
          }),
        ),
    );
    mockSend.mockRejectedValueOnce(new Error("Telegram unavailable"));
    mockSendError.mockRejectedValueOnce(new Error("Telegram unavailable"));
    const txns = [
      transactionRow({ uniqueId: "one" }),
      transactionRow({ uniqueId: "two" }),
    ];
    await expect(
      new InvoiceCreator(invoiceConfig).createInvoicesForTransactions(txns),
    ).resolves.toBe(txns);
    expect(mockSend).toHaveBeenCalledWith(
      "🧾 InvoiceCreator finished: 2/2 newly recorded, 0 existing, 0 failed",
    );
  });

  it("includes the configured customer CRN in the EZcount request", async () => {
    const mockFetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          pdf_link: "https://pdf",
          doc_number: "123",
        }),
        { status: 200 },
      ),
    );
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
    const mockFetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          pdf_link: "https://pdf",
          doc_number: "123",
        }),
        { status: 200 },
      ),
    );
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
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://pdf",
            doc_number: "123",
          }),
          {
            status: 200,
          },
        ),
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
      transactionRow({ description: "כלל ביטוח", uniqueId: "unique-2" }),
    ]);

    expect(mockSendError).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining("✅ Invoice newly recorded for הראל ביטוח"),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining("https://pdf"),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining(
        "🧾 InvoiceCreator finished: 1/2 newly recorded, 0 existing, 1 failed",
      ),
    );
  });

  it.each([
    { success: false, errNum: 7, errMsg: "invalid" },
    { success: false },
    {},
    null,
    { success: true },
    { success: true, pdf_link: "https://pdf" },
    { success: true, pdf_link: "", doc_number: "123" },
    { success: true, pdf_link: "https://pdf", doc_number: {} },
  ])("does not count an invalid HTTP 200 body as success: %j", async (body) => {
    const c = config();
    c.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body)));
    await new InvoiceCreator(c).createInvoicesForTransactions([
      transactionRow({}),
    ]);
    expect(mockSendError).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      "🧾 InvoiceCreator finished: 0/1 newly recorded, 0 existing, 1 failed",
    );
  });

  it.each(["missing", "failed"])(
    "suppresses individual successes when invoice history is %s",
    async (mode) => {
      const c = config();
      c.storage.invoice = {
        baseUrl: "https://example.com",
        developerEmail: "developer@example.com",
        apiKey: "test-key",
      };
      if (mode === "missing")
        mockGetInvoiceHistory.mockResolvedValue(undefined);
      else
        mockGetInvoiceHistory.mockRejectedValue(
          new Error("history unavailable"),
        );
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://pdf",
            doc_number: "123",
          }),
        ),
      );
      const txn = transactionRow({});
      await new InvoiceCreator(c).createInvoicesForTransactions([txn]);
      expect(txn).toMatchObject({ pdf_link: "https://pdf", doc_number: "123" });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        "🧾 InvoiceCreator finished: 0/1 newly recorded, 0 existing, 0 failed, 1 unclassified (creation/replay unknown)",
      );
    },
  );

  it("does not repeatedly notify for a saved transaction whose invoice mapping is missing", async () => {
    const c = config();
    c.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    mockGetInvoiceHistory.mockResolvedValue(new Map([["unique-1", {}]]));
    globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://pdf",
            doc_number: "123",
          }),
        ),
    );
    for (let run = 0; run < 2; run++) {
      await new InvoiceCreator(c).createInvoicesForTransactions([
        transactionRow({}),
      ]);
    }
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith(
      "🧾 InvoiceCreator finished: 0/1 newly recorded, 0 existing, 0 failed, 1 unclassified (creation/replay unknown)",
    );
  });

  it("reports mixed newly recorded, existing, and failed invoices exactly once", async () => {
    const c = config();
    c.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    mockGetInvoiceHistory.mockResolvedValue(
      new Map([
        ["old-hash", { pdf_link: "https://old", doc_number: "100" }],
        ["partial", { doc_number: "200" }],
      ]),
    );
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://partial",
            doc_number: "200",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://new",
            doc_number: 300,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const txns = [
      transactionRow({ uniqueId: "old", hash: "old-hash" }),
      transactionRow({ uniqueId: "partial" }),
      transactionRow({ uniqueId: "new" }),
      transactionRow({ uniqueId: "new" }),
      transactionRow({ uniqueId: "failure" }),
    ];
    await new InvoiceCreator(c).createInvoicesForTransactions(txns);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(txns[0]).toMatchObject({
      pdf_link: "https://old",
      doc_number: "100",
    });
    expect(txns[1]).toMatchObject({
      pdf_link: "https://partial",
      doc_number: "200",
    });
    expect(txns[2]).toMatchObject({
      pdf_link: "https://new",
      doc_number: "300",
    });
    expect(txns[3]).toMatchObject({
      pdf_link: "https://new",
      doc_number: "300",
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSendError).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      "🧾 InvoiceCreator finished: 1/5 newly recorded, 3 existing, 1 failed",
    );
  });

  it("continues after failure notification rejection and tolerates summary rejection", async () => {
    const c = config();
    c.storage.invoice = {
      baseUrl: "https://example.com",
      developerEmail: "developer@example.com",
      apiKey: "test-key",
    };
    mockSendError.mockRejectedValue(new Error("Telegram unavailable"));
    mockSend.mockRejectedValue(new Error("Telegram unavailable"));
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://pdf",
            doc_number: "123",
          }),
        ),
      );
    const txns = [
      transactionRow({ uniqueId: "one" }),
      transactionRow({ uniqueId: "two" }),
    ];
    await expect(
      new InvoiceCreator(c).createInvoicesForTransactions(txns),
    ).resolves.toBe(txns);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith(
      "🧾 InvoiceCreator finished: 1/2 newly recorded, 0 existing, 1 failed",
    );
  });

  it.each([
    ["פספורטכארד-י", "514831742"],
    ["הפניקס חברה-י", "520023185"],
  ])("uses the configured CRN for %s", async (description, customerCrn) => {
    const originalFetch = globalThis.fetch;
    const mockFetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          pdf_link: "https://pdf",
          doc_number: "123",
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = mockFetch;
    try {
      const invoiceConfig = config();
      invoiceConfig.storage.invoice = {
        baseUrl: "https://example.com",
        developerEmail: "developer@example.com",
        apiKey: "api-key",
        customerCrnByVendor: {
          "פספורטכארד-י": "514831742",
          פניקס: "520023185",
        },
      };
      await new InvoiceCreator(invoiceConfig).createInvoiceForTransaction(
        transactionRow({ description }),
      );
      const [, request] = mockFetch.mock.calls[0];
      expect(JSON.parse(String(request?.body))).toMatchObject({
        customer_name: description,
        customer_crn: customerCrn,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps every configured vendor to its CRN without making a real request", async () => {
    const mockFetch = jest.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            pdf_link: "https://pdf",
            doc_number: "123",
          }),
          { status: 200 },
        ),
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
