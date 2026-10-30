import { filterInsuranceVendorTransactions } from "./insurance-vendors.js";
import { transactionRow } from "../../utils/tests.js";

describe("invoice vendor selection", () => {
  it.each(["פספורטכארד-י", "הפניקס חברה-י", 'פניקס" חיים-י', "הראל ביטוח"])(
    "includes incoming payments from %s",
    (description) => {
      const txn = transactionRow({ description, originalAmount: 100 });
      expect(filterInsuranceVendorTransactions([txn])).toEqual([txn]);
    },
  );

  it("excludes outgoing payments, zero amounts, and unrelated vendors", () => {
    const txns = [
      transactionRow({ description: "פספורטכארד-י", originalAmount: -100 }),
      transactionRow({ description: "הפניקס חברה-י", originalAmount: 0 }),
      transactionRow({
        description: "unrelated transfer",
        originalAmount: 100,
      }),
    ];
    expect(filterInsuranceVendorTransactions(txns)).toEqual([]);
  });
});
