# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Moneyman** is a TypeScript/Node.js application that automates financial transaction scraping from Israeli banks and credit card companies, then exports the data to multiple storage backends. It's designed to centralize financial data for analytics, budgeting, and dashboard visualization.

**Core functionality:**
- Scrapes transactions from Israeli financial institutions using `israeli-bank-scrapers` library
- Supports 2FA/OTP authentication via Telegram
- Exports to 10+ storage backends (Google Sheets, YNAB, Azure Data Explorer, PostgreSQL, etc.)
- Runs on-demand or scheduled via GitHub Actions
- Provides real-time notifications and status updates via Telegram
- Includes security features like domain whitelisting and request filtering

## Development Commands

### Essential Commands
```bash
npm ci                              # Install dependencies (use in CI/new setup)
npm run build                       # Compile TypeScript to dst/ directory
npm start                           # Run the compiled application
npm run test                        # Run Jest test suite
npm run test:config                 # Validate configuration schema
npm run test:scraper-access         # Test scraper connectivity to bank websites
npm run lint                        # Check code formatting with Prettier
npm run lint:fix                    # Auto-fix formatting issues
```

### Development Workflow Commands
```bash
# Build and test cycle
npm run build && npm run test

# Run a single test file
npm test -- --testPathPattern=config.test.ts

# Debug with full logging
DEBUG=moneyman:* npm start

# Test configuration validation
npm run build && node dst/scripts/verify-config.js

# Docker development
npm run start:container            # Run via docker-compose
```

### GitHub Actions Workflows
- **Automatic scraping**: Runs twice daily at 10:05 and 22:05 UTC (main workflow)
- **Manual scraping**: `workflow_dispatch` trigger with custom container tags
- **Build & publish**: Automatic Docker image builds on main branch changes
- **PR testing**: Runs connection tests on pull requests

## Architecture

### High-Level Structure

The application follows a **pipeline architecture** with clear separation of concerns:

```
Configuration (config.ts) → Scraper (browser automation) → Bot (data processing) → Storage backends
```

**Key components:**

1. **Configuration System** (`src/config.ts`): Zod-based runtime validation of JSON config
2. **Scraper Module** (`src/scraper/`): Browser automation, account scraping, OTP handling
3. **Bot Module** (`src/bot/`): Result processing, notifications, storage orchestration
4. **Storage Backends** (`src/bot/storage/`): 10+ storage provider implementations
5. **Security Layer** (`src/security/`): Domain filtering, whitelist/blacklist rules

### Data Flow

```
AccountScrapeResult[] → TransactionRow[] (standardized) → Multiple storage backends (parallel)
```

**Transaction processing:**
- Each transaction gets a `hash` and `uniqueId` for deduplication
- Supports both default and "moneyman" hashing algorithms
- Parallel saving to all enabled storage backends
- Individual storage failures don't block others

### Storage Architecture

All storage backends implement the `TransactionStorage` interface:
```typescript
export interface TransactionStorage {
  canSave(): boolean;
  saveTransactions(txns: TransactionRow[], onProgress): Promise<SaveStats>;
}
```

**Available backends:**
- `LocalJsonStorage` - File-based JSON export
- `GoogleSheetsStorage` - Google Sheets integration
- `YNABStorage` - YNAB (You Need A Budget) API
- `ActualBudgetStorage` - Actual Budget server
- `TelegramStorage` - Send transaction files via Telegram
- `AzureDataExplorerStorage` - Enterprise data warehouse
- `BuxferStorage` - Buxfer personal finance
- `WebPostStorage` - Generic HTTP POST endpoint
- `SqlStorage` - PostgreSQL database
- `MondayStorage` - Monday.com integration

## Configuration

### Configuration Sources
1. `MONEYMAN_CONFIG` environment variable (JSON string)
2. `MONEYMAN_CONFIG_PATH` environment variable (path to JSON/JSONC file)

**Use `config.example.jsonc` as a starting template.**

### Key Configuration Sections
```typescript
{
  accounts: Array<{companyId: string, password: string, ...}>,
  storage: {[backendName]: {enabled: boolean, ...}},
  options: {
    scraping: {
      daysBack: 10,
      maxParallelScrapers: 1,
      transactionHashType: "moneyman" | "",
      domainTracking: boolean
    },
    security: {
      firewallSettings: string[],  // Format: "<companyId> <ALLOW|BLOCK> <domain>"
      blockByDefault: boolean
    },
    notifications: {
      telegram: {apiKey: string, chatId: string, enableOtp: boolean}
    }
  }
}
```

### Security Configuration

Domain-based firewall rules control scraper access:
```typescript
options: {
  security: {
    firewallSettings: [
      "hapoalim ALLOW bankhapoalim.co.il",
      "visaCal BLOCK suspicious-domain.com"
    ]
  }
}
```

## Key Technical Details

### Browser Automation
- Uses Puppeteer via `israeli-bank-scrapers` library
- Each account gets an isolated browser context for security
- Supports headless and non-headless modes
- Configurable executable path for custom Chrome installations

### 2FA/OTP Support
- Telegram-based OTP prompt system for OneZero accounts
- Configurable timeout (default: 5 minutes)
- Supports phone number-based 2FA flows

### Parallel Processing
- Accounts are scraped in parallel (configurable limit)
- Storage backends save in parallel
- Error isolation prevents one failure from blocking others

### Logging and Debugging
```bash
# Enable debug logging
DEBUG=moneyman:* npm start

# Safe logging (no sensitive data to stdout)
MONEYMAN_UNSAFE_STDOUT=false npm start  # Logs to /tmp/moneyman.log

# Telegram config debugging
SEND_NEW_CONFIG_TO_TG=true npm start
```

### Environment Variables
- `TZ="Asia/Jerusalem"` - Timezone for timestamp formatting
- `MONEYMAN_CONFIG` - Inline JSON configuration
- `MONEYMAN_CONFIG_PATH` - Path to JSON/JSONC config file
- `MONEYMAN_UNSAFE_STDOUT` - Controls sensitive data logging (default: false)
- `MONEYMAN_LOG_FILE_PATH` - Log file location (default: /tmp/moneyman.log)
- `DEBUG` - Debug logging namespace (use `moneyman:*`)

## Development Guidelines

### Code Standards
- **TypeScript strict mode** enabled
- **ES modules** used throughout
- **Prettier** for code formatting (enforced via pre-commit hooks)
- **Jest** for testing with `ts-jest`

### Testing Strategy
- Unit tests co-located with source files (`.test.ts` suffix)
- Mock-based testing with `jest-mock-extended`
- Snapshot testing for message formatting
- Connection testing for scraper access validation
- Configuration validation testing

### Security Considerations
- Domain tracking and filtering for scrapers
- Secure credential handling (use proper secret management)
- Log file security (sensitive data not in stdout by default)
- Isolated browser contexts per account
- Configurable firewall rules per scraper

### Docker Usage
```bash
# Local development
docker compose up

# Production deployment
docker run --rm \
  -e MONEYMAN_CONFIG_PATH=/config/config.json \
  -v /path/to/config:/config \
  ghcr.io/daniel-hauser/moneyman:latest

# Using Docker secrets
docker run --rm \
  --secret config.json \
  -e MONEYMAN_CONFIG_PATH=/run/secrets/config.json \
  ghcr.io/daniel-hauser/moneyman:latest
```

## Common Development Tasks

### Adding a New Storage Backend
1. Create new class in `src/bot/storage/` extending the `TransactionStorage` interface
2. Add configuration schema to `src/config.schema.ts`
3. Register in `src/bot/storage/index.ts`
4. Add tests following existing patterns

### Modifying Configuration Schema
1. Update Zod schemas in `src/config.schema.ts`
2. Update TypeScript types
3. Test with `npm run test:config`
4. Update `config.example.jsonc`

### Working with israeli-bank-scrapers
- Library handles the actual bank website automation
- Moneyman wraps it with configuration, parallel processing, and storage
- Check library documentation for new companyId values and credential requirements
- Use `npm run test:scraper-access` to validate connectivity

### Debugging Scraper Issues
1. Enable debug logging: `DEBUG=moneyman:* npm start`
2. Use domain tracking: `options.scraping.domainTracking: true`
3. Enable OTP if using 2FA accounts
4. Check Telegram for real-time progress updates and error messages
5. Review log files (default: `/tmp/moneyman.log`) for detailed error information

### Working with Patch-Package
- `patches/` directory contains dependency patches
- `npm run postinstall` applies patches automatically
- Use `patch-package <package-name>` to create new patches