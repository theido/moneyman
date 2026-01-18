// Mock the google-spreadsheet module before imports
jest.mock("google-spreadsheet", () => ({
  GoogleSpreadsheet: jest.fn(),
}));
jest.mock("google-auth-library");

// Mock logger
jest.mock("../utils/logger.js", () => ({
  createLogger: () => jest.fn(),
}));

// Mock notifier
jest.mock("./notifier.js", () => ({
  send: jest.fn(),
  sendError: jest.fn(),
}));

// Mock config
jest.mock("../config.js", () => ({
  config: {
    options: {
      notifications: {
        insights: {
          enabled: false,
        },
      },
    },
    storage: {},
  },
}));

import {
  calculateMonthlyInsights,
  formatInsightsMessage,
  type MonthlyInsights,
} from "./insights.js";
import type { SheetTransaction } from "./storage/sheets.js";

describe("insights", () => {
  describe("calculateMonthlyInsights", () => {
    it("should calculate totals correctly", () => {
      const transactions: SheetTransaction[] = [
        {
          date: new Date(2024, 0, 5),
          amount: -100,
          description: "Groceries",
          category: "Food",
          account: "main",
          memo: "",
        },
        {
          date: new Date(2024, 0, 10),
          amount: -50,
          description: "Gas",
          category: "Transportation",
          account: "main",
          memo: "",
        },
        {
          date: new Date(2024, 0, 15),
          amount: 5000,
          description: "Salary",
          category: "Income",
          account: "main",
          memo: "",
        },
      ];

      const insights = calculateMonthlyInsights(transactions, 2024, 1);

      expect(insights.totalExpenses).toBe(150);
      expect(insights.totalIncome).toBe(5000);
      expect(insights.balance).toBe(4850);
      expect(insights.transactionCount).toBe(3);
    });

    it("should calculate category breakdown correctly", () => {
      const transactions: SheetTransaction[] = [
        {
          date: new Date(2024, 0, 5),
          amount: -100,
          description: "Groceries",
          category: "Food",
          account: "main",
          memo: "",
        },
        {
          date: new Date(2024, 0, 6),
          amount: -50,
          description: "More food",
          category: "Food",
          account: "main",
          memo: "",
        },
        {
          date: new Date(2024, 0, 10),
          amount: -50,
          description: "Gas",
          category: "Transportation",
          account: "main",
          memo: "",
        },
      ];

      const insights = calculateMonthlyInsights(transactions, 2024, 1);

      expect(insights.categoryBreakdown).toHaveLength(2);
      expect(insights.categoryBreakdown[0].category).toBe("Food");
      expect(insights.categoryBreakdown[0].amount).toBe(150);
      expect(insights.categoryBreakdown[0].percentage).toBe(75);
      expect(insights.categoryBreakdown[1].category).toBe("Transportation");
      expect(insights.categoryBreakdown[1].amount).toBe(50);
      expect(insights.categoryBreakdown[1].percentage).toBe(25);
    });

    it("should handle transactions without category", () => {
      const transactions: SheetTransaction[] = [
        {
          date: new Date(2024, 0, 5),
          amount: -100,
          description: "Unknown",
          category: "",
          account: "main",
          memo: "",
        },
      ];

      const insights = calculateMonthlyInsights(transactions, 2024, 1);

      expect(insights.categoryBreakdown).toHaveLength(1);
      expect(insights.categoryBreakdown[0].category).toBe("Uncategorized");
      expect(insights.categoryBreakdown[0].amount).toBe(100);
    });

    it("should handle no transactions", () => {
      const transactions: SheetTransaction[] = [];

      const insights = calculateMonthlyInsights(transactions, 2024, 1);

      expect(insights.totalExpenses).toBe(0);
      expect(insights.totalIncome).toBe(0);
      expect(insights.balance).toBe(0);
      expect(insights.transactionCount).toBe(0);
      expect(insights.categoryBreakdown).toHaveLength(0);
    });

    it("should calculate daily average for past month", () => {
      const transactions: SheetTransaction[] = [
        {
          date: new Date(2024, 0, 5),
          amount: -310,
          description: "Various",
          category: "General",
          account: "main",
          memo: "",
        },
      ];

      // January 2024 has 31 days
      const insights = calculateMonthlyInsights(transactions, 2024, 1);

      // Daily average = 310 / 31 = 10
      expect(insights.daysInMonth).toBe(31);
      expect(insights.daysSoFar).toBe(31); // Past month, all days counted
      expect(insights.dailyAverage).toBe(10);
    });

    it("should sort categories by amount descending", () => {
      const transactions: SheetTransaction[] = [
        {
          date: new Date(2024, 0, 1),
          amount: -50,
          description: "Small",
          category: "Small",
          account: "main",
          memo: "",
        },
        {
          date: new Date(2024, 0, 2),
          amount: -200,
          description: "Large",
          category: "Large",
          account: "main",
          memo: "",
        },
        {
          date: new Date(2024, 0, 3),
          amount: -100,
          description: "Medium",
          category: "Medium",
          account: "main",
          memo: "",
        },
      ];

      const insights = calculateMonthlyInsights(transactions, 2024, 1);

      expect(insights.categoryBreakdown[0].category).toBe("Large");
      expect(insights.categoryBreakdown[1].category).toBe("Medium");
      expect(insights.categoryBreakdown[2].category).toBe("Small");
    });

    it("should not include income in category breakdown", () => {
      const transactions: SheetTransaction[] = [
        {
          date: new Date(2024, 0, 1),
          amount: 5000,
          description: "Salary",
          category: "Income",
          account: "main",
          memo: "",
        },
        {
          date: new Date(2024, 0, 2),
          amount: -100,
          description: "Food",
          category: "Food",
          account: "main",
          memo: "",
        },
      ];

      const insights = calculateMonthlyInsights(transactions, 2024, 1);

      expect(insights.categoryBreakdown).toHaveLength(1);
      expect(insights.categoryBreakdown[0].category).toBe("Food");
    });
  });

  describe("formatInsightsMessage", () => {
    const sampleInsights: MonthlyInsights = {
      year: 2024,
      month: 1,
      monthName: "January 2024",
      totalExpenses: 5432.5,
      totalIncome: 8000,
      balance: 2567.5,
      transactionCount: 50,
      daysInMonth: 31,
      daysSoFar: 18,
      dailyAverage: 301.81,
      categoryBreakdown: [
        { category: "Groceries", amount: 1500, percentage: 27.6 },
        { category: "Transportation", amount: 800, percentage: 14.7 },
        { category: "Restaurants", amount: 650, percentage: 12 },
        { category: "Utilities", amount: 450, percentage: 8.3 },
        { category: "Entertainment", amount: 320, percentage: 5.9 },
        { category: "Other", amount: 100, percentage: 1.8 },
      ],
    };

    it("should format complete message with all options", () => {
      const message = formatInsightsMessage(sampleInsights, {
        showCategories: true,
        maxCategories: 5,
        showDailyAverage: true,
      });

      expect(message).toMatchSnapshot();
    });

    it("should hide categories when disabled", () => {
      const message = formatInsightsMessage(sampleInsights, {
        showCategories: false,
        showDailyAverage: true,
      });

      expect(message).not.toContain("Top Categories");
      expect(message).not.toContain("Groceries");
      expect(message).toMatchSnapshot();
    });

    it("should hide daily average when disabled", () => {
      const message = formatInsightsMessage(sampleInsights, {
        showCategories: false,
        showDailyAverage: false,
      });

      expect(message).not.toContain("Daily avg");
      expect(message).toMatchSnapshot();
    });

    it("should limit categories to maxCategories", () => {
      const message = formatInsightsMessage(sampleInsights, {
        showCategories: true,
        maxCategories: 3,
        showDailyAverage: false,
      });

      expect(message).toContain("Groceries");
      expect(message).toContain("Transportation");
      expect(message).toContain("Restaurants");
      expect(message).not.toContain("Utilities");
      expect(message).toMatchSnapshot();
    });

    it("should format negative balance correctly", () => {
      const negativeBalanceInsights: MonthlyInsights = {
        ...sampleInsights,
        totalExpenses: 10000,
        totalIncome: 5000,
        balance: -5000,
      };

      const message = formatInsightsMessage(negativeBalanceInsights, {
        showCategories: false,
        showDailyAverage: false,
      });

      expect(message).toContain("-5,000.00");
      expect(message).toMatchSnapshot();
    });

    it("should handle empty category breakdown", () => {
      const noExpensesInsights: MonthlyInsights = {
        ...sampleInsights,
        totalExpenses: 0,
        categoryBreakdown: [],
      };

      const message = formatInsightsMessage(noExpensesInsights, {
        showCategories: true,
        showDailyAverage: false,
      });

      expect(message).not.toContain("Top Categories");
      expect(message).toMatchSnapshot();
    });

    it("should use default options when not provided", () => {
      const message = formatInsightsMessage(sampleInsights);

      expect(message).toContain("Top Categories");
      expect(message).toContain("Daily avg");
      expect(message).toMatchSnapshot();
    });
  });
});
