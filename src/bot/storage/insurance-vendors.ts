import type { TransactionRow } from "../../types.js";

/**
 * Filters transactions to only include those from insurance vendors
 * @param transactions Array of transactions to filter
 * @returns Filtered transactions that match insurance vendors
 */
export function filterInsuranceVendorTransactions(
  transactions: TransactionRow[],
): TransactionRow[] {
  const vendors = [
    "ילין",
    "אלטשולר",
    "מור",
    "אנליסט",
    "מגדל",
    "כלל",
    "הראל",
    "מנורה",
    'פניקס" חיים-י',
    "הפניקס חברה-י",
    "פספורטכארד-י",
  ];
  const vendorRegex = new RegExp(vendors.join("|"));

  return transactions
    .filter((txn) => txn.originalAmount > 0)
    .filter(
      (txn) =>
        typeof txn.description === "string" &&
        vendorRegex.test(txn.description),
    );
}
