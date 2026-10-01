/**
 * Ahmedabad & Gandhinagar IT Companies Scraper - Google Maps Edition
 * 
 * Interactive Playwright scraper that uses Google Maps (google.com/maps)
 * to discover ALL IT and software companies in Ahmedabad and Gandhinagar without limits.
 * 
 * Extracts:
 * - company_name
 * - location (Ahmedabad or Gandhinagar)
 * - company_website
 * 
 * Results are saved incrementally to output/ahmedabad_gandhinagar_companies.csv.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const OUTPUT_DIR = path.join(__dirname, 'output');

const CSV_COLUMNS = ['company_name', 'location', 'company_website'];

// Aggregator / directory / social / job board domains to exclude
const DIRECTORY_DOMAINS = [
  'google.com', 'google.co.in', 'bing.com', 'yahoo.com', 'duckduckgo.com',
  'linkedin.com', 'glassdoor.com', 'glassdoor.co.in', 'indeed.com', 'indeed.co.in',
  'ambitionbox.com', 'naukri.com', 'monster.com', 'foundit.in', 'shine.com',
  'internshala.com', 'hirist.tech', 'cutshort.io', 'instahyre.com', 'wellfound.com',
  'angel.co', 'clutch.co', 'goodfirms.co', 'themanifest.com', 'upwork.com',
  'freelancer.com', 'topdevelopers.co', 'topflightapps.com', 'wikipedia.org',
  'quora.com', 'medium.com', 'github.com', 'youtube.com', 'facebook.com',
  'twitter.com', 'x.com', 'instagram.com', 'reddit.com', 'pinterest.com',
  'geeksforgeeks.org', 'javatpoint.com', 'w3schools.com', 'tutorialspoint.com',
  'techbehemoths.com', 'selectedfirms.co', 'sortlist.com', 'designrush.com',
  'superbcompanies.com', 'trustpilot.com', 'g2.com', 'capterra.com',
  'softwareadvice.com', 'crunchbase.com', 'zoominfo.com', 'scribd.com',
  'justdial.com', 'indiamart.com', 'sulekha.com', 'tradeindia.com',
  'magicbricks.com', '99acres.com', 'housing.com', 'mapsofindia.com',
  'yellowpages.in', 'business-standard.com', 'economictimes.indiatimes.com',
  'builtin.com'
];

// Patterns for non-IT entities accidentally matched in generic category queries
const NON_IT_PATTERNS = [
  /\b(?:residency|apartment|appartment|complex|enclave|towers?|heights|villas?|housing|bungalows?|plots?)\b/i,
  /\b(?:courier|cargo|transport|packers\s*(?:and|&)\s*movers|logistics)\b/i,
  /\b(?:salon|spa|beauty|parlour|makeup|hair)\b/i,
  /\b(?:paying\s*guest|pg|guest\s*house|hostel|hotel|resort|lodge)\b/i,
  /\b(?:hospital|clinic|nursing|maternity|pathology|doctor|chemist|pharmacy)\b/i,
  /\b(?:cab|taxi|travels|car\s*rent|car\s*repair|auto\s*garage)\b/i,
  /\b(?:cleaning|laundry|dry\s*clean|pest\s*control|security\s*guard|housekeeping)\b/i,
  /\b(?:restaurant|cafe|sweets|bakery|caterers|bhojanalay)\b/i
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadConfig() {
  const defaults = {
    locations: ['Ahmedabad', 'Gandhinagar'],
    outputFile: 'output/ahmedabad_gandhinagar_companies.csv',
    companyTypes: [
      'IT companies',
      'software companies',
      'web development companies',
      'software development company',
      'mobile app development company',
      'IT services companies',
      'tech startups'
    ],
    maxCompanies: 0, // 0 = unlimited / no limit
    headless: false
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), 'utf8');
    return { ...defaults, maxCompanies: Infinity };
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const max = typeof parsed.maxCompanies === 'number' && parsed.maxCompanies > 0 ? parsed.maxCompanies : Infinity;
    const outName = parsed.outputFile ? path.resolve(__dirname, parsed.outputFile) : path.join(OUTPUT_DIR, 'ahmedabad_gandhinagar_companies.csv');
    return {
      locations: Array.isArray(parsed.locations) && parsed.locations.length > 0 ? parsed.locations : defaults.locations,
      outputFile: outName,
      companyTypes: Array.isArray(parsed.companyTypes) && parsed.companyTypes.length > 0 ? parsed.companyTypes : defaults.companyTypes,
      maxCompanies: max,
      headless: typeof parsed.headless === 'boolean' ? parsed.headless : defaults.headless
    };
  } catch {
    return {
      ...defaults,
      outputFile: path.join(OUTPUT_DIR, 'ahmedabad_gandhinagar_companies.csv'),
      maxCompanies: Infinity
    };
  }
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).trim();
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  result.push(current);
  return result;
}

function initCsv(csvPath) {
  const dir = path.dirname(csvPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existingKeys = new Set();

  if (fs.existsSync(csvPath)) {
    try {
      const content = fs.readFileSync(csvPath, 'utf8');
      const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
      if (lines.length > 1) {
        for (let i = 1; i < lines.length; i++) {
          const cells = parseCsvLine(lines[i]);
          if (cells.length > 0 && cells[0]) {
            existingKeys.add(cells[0].trim().toLowerCase());
          }
        }
      }
      console.log(`[CSV] Loaded existing ${csvPath} with ${existingKeys.size} companies.`);
    } catch (err) {
      console.warn(`[CSV] Initializing fresh CSV: ${err.message}`);
    }
  } else {
    fs.writeFileSync(csvPath, CSV_COLUMNS.join(',') + '\n', 'utf8');
    console.log(`[CSV] Created new CSV file at ${csvPath}`);
  }

  return existingKeys;
}

function saveCompany(csvPath, company, existingKeys) {
  const key = company.company_name.trim().toLowerCase();
  if (existingKeys.has(key)) {
    return false;
  }

  const row = [
    escapeCsv(company.company_name),
    escapeCsv(company.location),
    escapeCsv(company.company_website)
  ].join(',') + '\n';

  fs.appendFileSync(csvPath, row, 'utf8');
  existingKeys.add(key);
  console.log(`[CSV +] #${existingKeys.size} | ${company.company_name} | Location: ${company.location} | Website: ${company.company_website || 'N/A'}`);
  return true;
}

function cleanCompanyName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let name = raw.trim();

  // Reject lists, questions, forum posts
  if (/^(?:Top|Best|List of|\d+)\s+\d+/i.test(name)) return '';
  if (/:\s*u\//i.test(name) || /reddit/i.test(name) || /quora/i.test(name)) return '';
  if (/\?$/.test(name) || /^(?:Which|What|How|Where|Why)\s/i.test(name)) return '';
  if (/^(?:Top|Best)\s+IT\s+Companies/i.test(name)) return '';

  // Filter out non-IT entities (apartments, hotels, hospitals, cabs, etc.)
  for (const pattern of NON_IT_PATTERNS) {
    if (pattern.test(name)) return '';
  }

  // Split on common Google subtitle delimiters: " - ", " – ", " — ", " | ", " : ", " • "
  for (const sep of [' - ', ' – ', ' — ', ' | ', ' : ', ' • ']) {
    if (name.includes(sep)) {
      const parts = name.split(sep);
      if (parts[0].trim().length >= 2 && /[a-zA-Z]/.test(parts[0])) {
        name = parts[0].trim();
        break;
      }
    }
  }

  // Strip trailing marketing promotional phrases
  const promotionalPhrases = [
    /\s*[-|–—:]\s*(?:Best|Top|Leading|Rated|No\.?\s*1)?\s*(?:IT|Software|Web|Mobile|App|Tech|SEO|Development|Designing|Services|Company|Consultancy|Startup|Solution|Solutions|Agency|India|Ahmedabad|Gandhinagar).*$/i,
    /\s*\/\s*(?:IT|Software).*$/i,
    /\s*\|\s*.*$/i,
    /\s*-\s*Ecommerce Web Developer.*$/i,
    /\s*Web Designing Company.*$/i
  ];
  for (const pattern of promotionalPhrases) {
    name = name.replace(pattern, '').trim();
  }

  // Clean trailing punctuation
  name = name.replace(/[-|–—:•/]+$/, '').trim();

  // Discard directory or social platform brand names
  if (DIRECTORY_DOMAINS.some(d => {
    const brand = d.split('.')[0];
    return brand.length > 2 && name.toLowerCase() === brand;
  })) return '';

  if (name.length < 2 || name.length > 60 || !/[a-zA-Z]/.test(name)) return '';
  return name;
}

function cleanWebsiteUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  let finalUrl = urlStr.trim();

  // Unwrap google redirect URLs
  if (finalUrl.includes('google.com/url') || finalUrl.includes('google.com/goto')) {
    try {
      const parsed = new URL(finalUrl);
      const q = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (q) finalUrl = q;
    } catch {}
  }

  try {
    const parsed = new URL(finalUrl);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return finalUrl;
  }
}

function isDirectoryUrl(urlStr) {
  if (!urlStr) return false;
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return DIRECTORY_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * Scrapes Google Maps search for a single query using continuous feed scrolling
 */
async function scrapeGoogleMapsQuery(page, queryInfo, csvPath, existingKeys, maxCompanies) {
  const { query, defaultLocation } = queryInfo;
  console.log(`\n======================================================`);
  console.log(`>>> [Google Maps] Query: "${query}" (Location: ${defaultLocation}) | Total: ${existingKeys.size}`);
  console.log(`======================================================`);

  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(2500);

    // Case 1: Google Maps redirected directly to a single place page (/maps/place/...)
    if (page.url().includes('/maps/place/')) {
      const singlePlace = await page.evaluate(() => {
        const titleEl = document.querySelector('h1, h1.DUwDvf');
        const webAnchor = document.querySelector('a[data-item-id="authority"], a[data-tooltip="Open website"], a[aria-label*="website" i]');
        return {
          name: titleEl ? titleEl.innerText.trim() : '',
          website: webAnchor ? webAnchor.href : ''
        };
      });

      if (singlePlace.name) {
        const cleanedName = cleanCompanyName(singlePlace.name);
        if (cleanedName && !existingKeys.has(cleanedName.toLowerCase())) {
          let cleanUrl = '';
          if (singlePlace.website && !isDirectoryUrl(singlePlace.website)) {
            cleanUrl = cleanWebsiteUrl(singlePlace.website);
          }
          saveCompany(csvPath, {
            company_name: cleanedName,
            location: defaultLocation,
            company_website: cleanUrl
          }, existingKeys);
        }
      }
      return;
    }

    // Case 2: Feed of multiple listings
    const feedSelector = 'div[role="feed"]';
    await page.waitForSelector(feedSelector, { timeout: 12000 }).catch(() => null);

    let prevCount = 0;
    let stagnantCount = 0;

    for (let scroll = 0; scroll < 30; scroll++) {
      if (existingKeys.size >= maxCompanies) return;

      // Extract cards currently loaded in DOM
      const items = await page.evaluate(() => {
        const list = [];
        const cards = document.querySelectorAll('div.Nv2PK');
        for (const card of cards) {
          const anchor = card.querySelector('a.hfpxzc');
          const name = anchor ? anchor.getAttribute('aria-label') : '';
          const webAnchor = card.querySelector('a[data-value="Website"], a[aria-label*="website" i]');
          if (name) {
            list.push({
              name: name.trim(),
              website: webAnchor ? webAnchor.href : ''
            });
          }
        }
        return list;
      });

      // Save valid new companies
      for (const item of items) {
        if (existingKeys.size >= maxCompanies) return;

        const cleanedName = cleanCompanyName(item.name);
        if (!cleanedName) continue;

        const compKey = cleanedName.toLowerCase();
        if (existingKeys.has(compKey)) continue;

        let cleanUrl = '';
        if (item.website && !isDirectoryUrl(item.website)) {
          cleanUrl = cleanWebsiteUrl(item.website);
        }

        saveCompany(csvPath, {
          company_name: cleanedName,
          location: defaultLocation,
          company_website: cleanUrl
        }, existingKeys);
      }

      // Check for Google Maps end-of-feed indicator
      const endReached = await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return false;
        return feed.innerText.includes("You've reached the end of the list") ||
               feed.innerText.includes("reached the end of the list");
      });

      if (endReached) {
        console.log(`[Google Maps] Reached end of list for "${query}".`);
        break;
      }

      if (items.length === prevCount) {
        stagnantCount++;
        if (stagnantCount >= 4) {
          console.log(`[Google Maps] No new cards after 4 scrolls, proceeding to next.`);
          break;
        }
      } else {
        stagnantCount = 0;
        prevCount = items.length;
      }

      // Scroll the Google Maps feed element
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 2200);
      });

      await sleep(1200);
    }
  } catch (err) {
    console.warn(`[Google Maps] Error scraping "${query}": ${err.message}`);
  }
}

/**
 * Builds comprehensive queries for Ahmedabad and Gandhinagar covering major IT corridors
 */
function buildAhmedabadGandhinagarQueries() {
  const gandhinagarAreas = [
    'Gandhinagar',
    'GIFT City Gandhinagar',
    'Infocity Gandhinagar',
    'Kudasan Gandhinagar',
    'Raysan Gandhinagar',
    'Sargasan Gandhinagar',
    'Randesan Gandhinagar',
    'Koba Gandhinagar',
    'Sector 11 Gandhinagar',
    'Sector 26 Gandhinagar'
  ];

  const ahmedabadAreas = [
    'Ahmedabad',
    'SG Highway Ahmedabad',
    'Prahlad Nagar Ahmedabad',
    'Sindhu Bhavan Road Ahmedabad',
    'Bodakdev Ahmedabad',
    'Vastrapur Ahmedabad',
    'Satellite Ahmedabad',
    'Thaltej Ahmedabad',
    'Makarba Ahmedabad',
    'Navrangpura Ahmedabad',
    'Ashram Road Ahmedabad',
    'C.G. Road Ahmedabad',
    'Gota Ahmedabad',
    'Chandkheda Ahmedabad',
    'Motera Ahmedabad',
    'Bopal Ahmedabad',
    'South Bopal Ahmedabad',
    'Shela Ahmedabad',
    'Science City Road Ahmedabad',
    'Iscon Ambli Road Ahmedabad',
    'Sanand Road Ahmedabad',
    'Paldi Ahmedabad',
    'Ellisbridge Ahmedabad',
    'Maninagar Ahmedabad',
    'Nikol Ahmedabad',
    'Naroda Ahmedabad'
  ];

  const itNiches = [
    'IT companies in',
    'software companies in',
    'software development company in',
    'web development company in',
    'mobile app development company in',
    'web design company in',
    'tech startups in',
    'IT services in',
    'digital agency software in'
  ];

  const queries = [];

  // Gandhinagar queries
  for (const area of gandhinagarAreas) {
    for (const niche of itNiches) {
      queries.push({
        query: `${niche} ${area}`,
        defaultLocation: 'Gandhinagar'
      });
    }
  }

  // Ahmedabad queries
  for (const area of ahmedabadAreas) {
    for (const niche of itNiches) {
      queries.push({
        query: `${niche} ${area}`,
        defaultLocation: 'Ahmedabad'
      });
    }
  }

  // Specialized IT queries for both cities
  const specialQueries = [
    { query: 'top IT companies in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'top IT companies in Gandhinagar', defaultLocation: 'Gandhinagar' },
    { query: 'IT companies in GIFT City', defaultLocation: 'Gandhinagar' },
    { query: 'software companies in Infocity Gandhinagar', defaultLocation: 'Gandhinagar' },
    { query: 'multinational IT companies in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'product software companies in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'custom software development company Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'fintech software companies in GIFT City Gandhinagar', defaultLocation: 'Gandhinagar' },
    { query: 'cloud consulting IT companies in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'artificial intelligence AI companies in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'blockchain development company in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'ERP software companies in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'cyber security companies in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'full stack development company in Ahmedabad', defaultLocation: 'Ahmedabad' },
    { query: 'ecommerce web development company in Ahmedabad', defaultLocation: 'Ahmedabad' }
  ];

  for (const sq of specialQueries) {
    if (!queries.some(q => q.query.toLowerCase() === sq.query.toLowerCase())) {
      queries.push(sq);
    }
  }

  return queries;
}

async function run() {
  console.log('================================================================');
  console.log('  Ahmedabad & Gandhinagar IT Companies Scraper (Google Maps)   ');
  console.log('  Mode: Exhaustive Search (No Limits)                           ');
  console.log('================================================================\n');

  const config = loadConfig();
  const existingKeys = initCsv(config.outputFile);

  const isUnlimited = config.maxCompanies === Infinity;
  console.log(`[Config] Target Locations: ${config.locations.join(', ')}`);
  console.log(`[Config] Output CSV: ${config.outputFile}`);
  console.log(`[Config] Max Companies: ${isUnlimited ? 'NO LIMIT (Unlimited)' : config.maxCompanies}`);
  console.log(`[Config] Headless: ${config.headless} (Interactive Browser)\n`);

  console.log('[Browser] Launching visible Chromium browser...');
  const browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
    locale: 'en-US'
  });

  const page = await context.newPage();
  const queryList = buildAhmedabadGandhinagarQueries();
  console.log(`[Strategy] Generated ${queryList.length} comprehensive Google Maps queries across Ahmedabad & Gandhinagar.\n`);

  try {
    for (let qIdx = 0; qIdx < queryList.length; qIdx++) {
      if (existingKeys.size >= config.maxCompanies) {
        console.log(`\n[Info] Reached target limit of ${config.maxCompanies} companies.`);
        break;
      }

      const qInfo = queryList[qIdx];
      console.log(`\n------------------------------------------------------`);
      console.log(`[Progress ${qIdx + 1}/${queryList.length}] Scraping: "${qInfo.query}"`);
      console.log(`------------------------------------------------------`);

      // Scrape Google Maps with continuous feed scrolling
      await scrapeGoogleMapsQuery(page, qInfo, config.outputFile, existingKeys, config.maxCompanies);

      // Brief breather between queries
      await sleep(1500);
    }

    console.log(`\n======================================================`);
    console.log(`[Complete] Finished Google Maps scrape for Ahmedabad & Gandhinagar.`);
    console.log(`[Total] Successfully scraped ${existingKeys.size} IT companies.`);
    console.log(`[Saved] All records written to: ${config.outputFile}`);
    console.log(`======================================================\n`);

  } catch (fatalErr) {
    console.error(`[Fatal Error] Scraper encountered an error: ${fatalErr.message}`);
  } finally {
    console.log('[Browser] Closing browser...');
    await browser.close().catch(() => {});
  }
}

// Run scraper
run();
