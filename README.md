# Surat IT Companies Scraper

An interactive, local-only Playwright-based scraper in Node.js that searches Google (Local Places and Organic search) to discover all IT companies in Surat.

All discovered companies are saved incrementally to **one CSV file only**: `output/matched_results.csv`.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Install the Chromium browser for Playwright:
   ```bash
   npx playwright install chromium
   ```

## Configuration

Edit `config.json` to customize your search parameters:

```json
{
  "locations": ["Surat"],
  "companyTypes": [
    "IT companies",
    "software companies",
    "web development companies",
    "software development company",
    "mobile app development company",
    "IT services companies",
    "tech startups"
  ],
  "maxCompanies": 200,
  "headless": false
}
```

- **`locations`**: Target location (Surat).
- **`companyTypes`**: Company categories and search query variations.
- **`maxCompanies`**: Maximum number of companies to discover per run (default: 200).
- **`headless`**: Set to `false` (default) to launch an interactive, visible browser window so you can watch Google in action.

## Available Scripts

| Script | Command | Description |
|---|---|---|
| **Company Discovery Scraper** | `npm run scrape:companies` (or `npm start`) | Scrapes Google Maps / Search for IT companies and saves to `output/matched_results.csv` |
| **Salary Verification Tool** | `npm run verify:salaries` | Verifies fresher tech salaries (SDE, Full Stack, Frontend, Backend) from AmbitionBox, Glassdoor, and Indeed |

---

## Salary Verification Tool

Verifies authentic salary data from the internet for companies discovered in `output/matched_results.csv`.

### Features
- **Strict Role Filtering**: Only software engineering roles (SDE, Full Stack, Frontend, Backend, Web Developer). Excludes UI/UX, Business Analyst, QA, Sales, etc.
- **Fresher Compensation Focus**: Targets freshers and entry-level (0–1 years).
- **Salary Threshold**: Flags companies offering **>= 5-6 LPA**.
- **Verified Sources**: Aggregates real employee-reported compensation from AmbitionBox, Glassdoor, and Indeed.
- **Output File**: Saves incrementally to `output/verified_fresher_salaries.csv`.

### Configuration (`salary_config.json`)

```json
{
  "inputFile": "output/matched_results.csv",
  "outputFile": "output/verified_fresher_salaries.csv",
  "minSalaryLpa": 5.0,
  "maxCompanies": 0,
  "headless": false,
  "delayBetweenRequestsMs": 2000,
  "includeOnlyQualifying": false
}
```

- **`inputFile`**: Source CSV containing company list (`output/matched_results.csv`).
- **`outputFile`**: Target CSV for verified salary records (`output/verified_fresher_salaries.csv`).
- **`minSalaryLpa`**: Minimum LPA threshold (default: `5.0`).
- **`maxCompanies`**: Maximum companies to check per run (`0` = all companies).
- **`headless`**: `false` to view browser verification live.
- **`includeOnlyQualifying`**: Set to `true` to save only companies qualifying >= 5 LPA, or `false` to log all checked companies with a clear `qualifies_above_5lpa` flag.

### Run Salary Verification

```bash
npm run verify:salaries
```

