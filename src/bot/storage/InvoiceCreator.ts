import { TransactionRow } from "../../types";
import type { MoneymanConfig } from "../../config.js";
import { send, sendError } from "../notifier.js";

export class InvoiceCreator {
  baseUrl: string;
  developerEmail: string;
  apiKey: string;
  customerCrn?: string;
  customerCrnByVendor?: Record<string, string>;

  constructor(config: MoneymanConfig) {
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
    return response.json();
  }

  async createInvoicesForTransactions(
    txns: Array<TransactionRow>,
  ): Promise<TransactionRow[]> {
    let created = 0;
    let failed = 0;

    for (const txn of txns) {
      try {
        const res = await this.createInvoiceForTransaction(txn);
        if (res.pdf_link) txn.pdf_link = res.pdf_link;
        if (res.doc_number) txn.doc_number = res.doc_number;
        created += 1;

        const invoiceLabel = txn.doc_number
          ? `#${txn.doc_number}`
          : txn.uniqueId || txn.hash || txn.description;
        const invoiceUrl = txn.pdf_link ? `\n${txn.pdf_link}` : "";
        await send(
          `✅ Invoice created for ${txn.description} (${invoiceLabel})${invoiceUrl}`,
        );
      } catch (e) {
        failed += 1;
        await sendError(
          e,
          `InvoiceCreator failed for ${txn.description} (${txn.uniqueId || txn.hash || "unknown"})`,
        );
      }
    }

    await send(
      `🧾 InvoiceCreator finished: ${created}/${txns.length} created, ${failed} failed`,
    );

    return txns;
  }
}
