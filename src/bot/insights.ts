import { format, getDaysInMonth } from "date-fns";
import { config } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { send, sendError } from "./notifier.js";
import {
  GoogleSheetsStorage,
  type SheetTransaction,
} from "./storage/sheets.js";

const logger = createLogger("insights");

export interface MonthlyInsights {
  year: number;
  month: number;
  monthName: string;
  totalExpenses: number;
  totalIncome: number;
  balance: number;
  transactionCount: number;
  daysInMonth: number;
  daysSoFar: number;
  dailyAverage: number;
  categoryBreakdown: CategoryBreakdown[];
}

export interface CategoryBreakdown {
  category: string;
  amount: number;
  percentage: number;
}

/**
 * Calculate monthly insights from a list of transactions.
 */
export function calculateMonthlyInsights(
  transactions: SheetTransaction[],
  year: number,
  month: number,
): MonthlyInsights {
  const now = new Date();
  const isCurrentMonth =
    now.getFullYear() === year && now.getMonth() + 1 === month;
  const daysSoFar = isCurrentMonth ? now.getDate() : getDaysInMonth(new Date(year, month - 1));
  const daysInMonth = getDaysInMonth(new Date(year, month - 1));

  // Separate expenses (negative) and income (positive)
  let totalExpenses = 0;
  let totalIncome = 0;
  const categoryTotals: Record<string, number> = {};

  for (const tx of transactions) {
    if (tx.amount < 0) {
      totalExpenses += Math.abs(tx.amount);
      // Track category for expenses only
      const category = tx.category || "Uncategorized";
      categoryTotals[category] = (categoryTotals[category] || 0) + Math.abs(tx.amount);
    } else {
      totalIncome += tx.amount;
    }
  }

  // Calculate category breakdown
  const categoryBreakdown: CategoryBreakdown[] = Object.entries(categoryTotals)
    .map(([category, amount]) => ({
      category,
      amount,
      percentage: totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  // Daily average is based on days so far in the month
  const dailyAverage = daysSoFar > 0 ? totalExpenses / daysSoFar : 0;

  return {
    year,
    month,
    monthName: format(new Date(year, month - 1), "MMMM yyyy"),
    totalExpenses,
    totalIncome,
    balance: totalIncome - totalExpenses,
    transactionCount: transactions.length,
    daysInMonth,
    daysSoFar,
    dailyAverage,
    categoryBreakdown,
  };
}

/**
 * Format a number as currency with thousands separator.
 */
function formatCurrency(amount: number): string {
  return amount.toLocaleString("en-IL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format insights as an HTML message for Telegram.
 */
export function formatInsightsMessage(
  insights: MonthlyInsights,
  options?: {
    showCategories?: boolean;
    maxCategories?: number;
    showDailyAverage?: boolean;
  },
): string {
  const {
    showCategories = true,
    maxCategories = 5,
    showDailyAverage = true,
  } = options || {};

  const lines: string[] = [];

  // Header
  lines.push(`<b>Monthly Insights - ${insights.monthName}</b>`);
  lines.push("");

  // Main totals
  lines.push(`Expenses: <b>${formatCurrency(insights.totalExpenses)}</b> ILS`);
  lines.push(`Income: <b>${formatCurrency(insights.totalIncome)}</b> ILS`);

  const balanceSign = insights.balance >= 0 ? "+" : "";
  lines.push(
    `Balance: <b>${balanceSign}${formatCurrency(insights.balance)}</b> ILS`,
  );

  // Daily average
  if (showDailyAverage) {
    lines.push("");
    lines.push(
      `Daily avg: <b>${formatCurrency(insights.dailyAverage)}</b> ILS/day (${insights.daysSoFar} days)`,
    );
  }

  // Category breakdown
  if (showCategories && insights.categoryBreakdown.length > 0) {
    lines.push("");
    lines.push("<b>Top Categories</b>");

    const topCategories = insights.categoryBreakdown.slice(0, maxCategories);
    for (const cat of topCategories) {
      lines.push(
        `  ${cat.category}: ${formatCurrency(cat.amount)} ILS (${cat.percentage.toFixed(1)}%)`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Main entry point: Load transactions from Google Sheets and send monthly insights.
 */
export async function sendMonthlyInsights(): Promise<void> {
  const insightsConfig = config.options.notifications?.insights;

  if (!insightsConfig?.enabled) {
    logger("Insights are not enabled, skipping");
    return;
  }

  if (!config.storage.googleSheets) {
    logger("Google Sheets storage not configured, cannot generate insights");
    await sendError(
      new Error("Monthly insights require Google Sheets storage to be configured"),
      "sendMonthlyInsights",
    );
    return;
  }

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    logger(`Generating monthly insights for ${month}/${year}`);

    const sheetsStorage = new GoogleSheetsStorage(config);
    const transactions = await sheetsStorage.getTransactionsForMonth(year, month);

    if (transactions.length === 0) {
      logger("No transactions found for current month");
      return;
    }

    const insights = calculateMonthlyInsights(transactions, year, month);
    const message = formatInsightsMessage(insights, {
      showCategories: insightsConfig.showCategories,
      maxCategories: insightsConfig.maxCategories,
      showDailyAverage: insightsConfig.showDailyAverage,
    });

    await send(message, "HTML");
    logger("Monthly insights sent successfully");
  } catch (error) {
    logger("Failed to send monthly insights", error);
    await sendError(error, "sendMonthlyInsights");
  }
}
