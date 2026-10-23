import type { TransactionRow } from "../../types.js";
import { getInvoiceHistory, type InvoiceMapping } from "./InvoiceHistory.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("InvoiceCreator");
import type { MoneymanConfig } from "../../config.js";
import { send, sendError } from "../notifier.js";

export class InvoiceCreator {
  baseUrl: string;
  developerEmail: string;
  apiKey: string;
  customerCrn?: string;
  customerCrnByVendor?: Record<string, string>;

  constructor(private config: MoneymanConfig) {
    const invoiceConfig = config.storage.invoice;
    if (!invoiceConfig) {
      throw new Error(
        "Invoice configuration not found in config.storage.invoice",
      );
    }
    this.baseUrl = invoiceConfig.baseUrl;
    this.developerEmail = invoiceConfig.developerEmail;
    this.apiKey = invoiceConfig.apiKey;
    this.customerCrn = invoiceConfig.customerCrn;
    this.customerCrnByVendor = invoiceConfig.customerCrnByVendor;
  }

  private getCustomerCrn(description: string): string | undefined {
    const matchingVendor = Object.keys(this.customerCrnByVendor ?? {}).find(
      (vendor) => description.includes(vendor),
    );
    return matchingVendor
      ? this.customerCrnByVendor?.[matchingVendor]
      : this.customerCrn;
  }

  // Helper to format date as DD/MM/YYYY
  private formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    const day = String(d.getUTCDate()).padStart(2, "0");
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const year = d.getUTCFullYear();
    return `${day}/${month}/${year}`;
  }

  async createInvoiceForTransaction(txn: TransactionRow) {
    if (!txn.uniqueId?.trim()) {
      throw new Error("Invoice transaction_id is required");
    }
    // You can adjust these values as needed
    const price = Math.abs(txn.originalAmount);
    const date = this.formatDate(txn.processedDate);
    const body = {
      developer_email: this.developerEmail,
      api_key: this.apiKey,
      date: date,
      type: 320,
      transaction_id: txn.uniqueId,
      customer_name: txn.description,
      ...(this.getCustomerCrn(txn.description)
        ? { customer_crn: this.getCustomerCrn(txn.description) }
        : {}),
      forceItemsIntoNonItemsDocument: 1,
      show_items_including_vat: 1,
      item: [
        {
          details: "עמלת סוכן",
          price: price,
          amount: 1,
          vat_type: "INC",
        },
      ],
      payment: [
        {
          payment_type: 4,
          payment_sum: price,
          date: date,
        },
      ],
      price_total: price,
    };
    const response = await fetch(`${this.baseUrl}/api/createDoc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to create invoice for txn ${txn.uniqueId || txn.hash}`,
      );
    }
    const result = await response.json();
    if (result && typeof result === "object" && result.errNum != null) {
      // Do not log the full response: provider errors can echo request secrets.
      throw new Error(`EZcount error ${result.errNum}`);
    }
    if (
      !result ||
      result.success !== true ||
      typeof result.pdf_link !== "string" ||
      !result.pdf_link ||
      !["string", "number"].includes(typeof result.doc_number) ||
      !String(result.doc_number)
    ) {
      throw new Error("Invalid EZcount success response");
    }
    return {
      pdf_link: result.pdf_link as string,
      doc_number: String(result.doc_number),
    };
  }

  private async notify(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch {
      // Delivery failure is not invoice failure; do not retry through the same notifier.
      logger("Invoice notification delivery failed");
    }
  }

  async createInvoicesForTransactions(
    txns: Array<TransactionRow>,
  ): Promise<TransactionRow[]> {
    let recorded = 0;
    let existing = 0;
    let failed = 0;
    let unclassified = 0;
    let history: Map<string, InvoiceMapping> | undefined;
    try {
      history = await getInvoiceHistory(this.config);
    } catch {
      logger(
        "Invoice history unavailable; new/existing classification disabled",
      );
      await this.notify(() =>
        sendError(
          new Error(
            "Invoice history unavailable; successes will be unclassified",
          ),
          "InvoiceCreator history",
        ),
      );
    }
    // Only supplementary deduplication within this batch; cross-run state comes
    // from durable history, never a process-local cache.
    const completed = new Map<string, InvoiceMapping>();
    for (const txn of txns) {
      const previous =
        completed.get(txn.uniqueId) ||
        history?.get(txn.uniqueId) ||
        history?.get(txn.hash);
      const knownExisting = Boolean(
        previous?.doc_number ||
        previous?.pdf_link ||
        txn.doc_number ||
        txn.pdf_link,
      );
      if (previous?.pdf_link) txn.pdf_link = previous.pdf_link;
      if (previous?.doc_number) txn.doc_number = previous.doc_number;
      try {
        if (!txn.pdf_link || !txn.doc_number) {
          const result = await this.createInvoiceForTransaction(txn);
          txn.pdf_link = result.pdf_link;
          txn.doc_number = result.doc_number;
        }
      } catch (error) {
        failed += 1;
        await this.notify(() =>
          sendError(
            error,
            `InvoiceCreator failed for ${txn.description} (${txn.uniqueId || txn.hash || "unknown"})`,
          ),
        );
        continue;
      }
      completed.set(txn.uniqueId, {
        pdf_link: txn.pdf_link,
        doc_number: txn.doc_number,
      });
      if (knownExisting) {
        existing += 1;
      } else if (history && !previous) {
        // EZcount has no documented replay flag. Absence from our history means
        // newly recorded here, NOT proof that EZcount created a new document.
        recorded += 1;
        await this.notify(() =>
          send(
            `✅ Invoice newly recorded for ${txn.description} (#${txn.doc_number})\n${txn.pdf_link}`,
          ),
        );
      } else {
        // No durable basis for distinguishing creation from transaction_id replay.
        unclassified += 1;
      }
    }
    await this.notify(() =>
      send(
        `🧾 InvoiceCreator finished: ${recorded}/${txns.length} newly recorded, ${existing} existing, ${failed} failed` +
          (unclassified
            ? `, ${unclassified} unclassified (creation/replay unknown)`
            : ""),
      ),
    );
    return txns;
  }
}
