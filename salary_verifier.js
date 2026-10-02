/**
 * Fresher Software Developer & SDE Salary Verification Scraper
 * 
 * Verifies fresher (0-1 yrs) tech compensation from AmbitionBox, Glassdoor, and Indeed
 * for companies listed in output/matched_results.csv.
 * 
 * Filters:
 * - Strictly INCLUDES: SDE, Software Engineer, Full Stack, Frontend, Backend developers
 * - Strictly EXCLUDES: UI/UX, Business Analyst (BA), QA/Testing, Sales/Marketing
 * - Flags companies meeting fresher salary threshold >= 5-6 LPA
 * 
 * Saves results incrementally to output/verified_fresher_salaries.csv
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CONFIG_PATH = path.join(__dirname, 'salary_config.json');

const CSV_HEADERS = [
  'company_name',
  'location',
  'company_website',
  'matched_role',
  'experience_level',
  'salary_min_lpa',
  'salary_max_lpa',
  'salary_avg_lpa',
  'salary_raw_text',
  'qualifies_above_5lpa',
  'salary_source',
  'source_url',
  'verified_at'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadConfig() {
  const defaults = {
    inputFile: 'output/matched_results.csv',
    outputFile: 'output/verified_fresher_salaries.csv',
    minSalaryLpa: 5.0,
    maxCompanies: 0,
    headless: false,
    delayBetweenRequestsMs: 2000,
    includeOnlyQualifying: false
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaults,
      ...parsed,
      inputFile: parsed.inputFile ? path.resolve(__dirname, parsed.inputFile) : path.join(__dirname, defaults.inputFile),
      outputFile: parsed.outputFile ? path.resolve(__dirname, parsed.outputFile) : path.join(__dirname, defaults.outputFile)
    };
  } catch (err) {
    console.warn(`[Config] Failed to parse ${CONFIG_PATH}, using defaults.`, err.message);
    return defaults;
  }
}

function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

function initOutputCsv(outputFilePath) {
  const processedCompanies = new Set();
  const dir = path.dirname(outputFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(outputFilePath)) {
    try {
      const content = fs.readFileSync(outputFilePath, 'utf8');
      const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
      for (let i = 1; i < lines.length; i++) {
        const firstComma = lines[i].indexOf(',');
        if (firstComma > -1) {
          let name = lines[i].substring(0, firstComma).trim();
          if (name.startsWith('"') && name.endsWith('"')) {
            name = name.slice(1, -1).replace(/""/g, '"');
          }
          if (name) {
            processedCompanies.add(name.toLowerCase());
          }
        }
      }
      console.log(`[CSV] Found existing output file. Loaded ${processedCompanies.size} already processed companies.`);
    } catch (e) {
      console.warn(`[CSV] Could not read existing output file: ${e.message}`);
    }
  } else {
    fs.writeFileSync(outputFilePath, CSV_HEADERS.map(h => escapeCsv(h)).join(',') + '\n', 'utf8');
    console.log(`[CSV] Initialized new output CSV: ${outputFilePath}`);
  }

  return processedCompanies;
}

function readInputCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input CSV file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const cols = [];
    let cur = '';
    let inQuotes = false;

    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        if (inQuotes && line[c + 1] === '"') {
          cur += '"';
          c++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cols.push(cur.trim());
        cur = '';
      } else {
        cur += char;
      }
    }
    cols.push(cur.trim());

    if (cols.length >= 2) {
      records.push({
        company_name: cols[0] || '',
        location: cols[1] || '',
        company_website: cols[2] || ''
      });
    }
  }

  return records;
}

/**
 * Strips noise, locations, promotional text, and legal entity suffixes
 * from company names to make search queries concise and accurate.
 */
function cleanCompanyName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let name = raw.trim();

  // Strip common subtitle delimiters
  for (const sep of [' - ', ' – ', ' — ', ' | ', ' : ', ' • ']) {
    if (name.includes(sep)) {
      const parts = name.split(sep);
      if (parts[0].trim().length >= 2) {
        name = parts[0].trim();
        break;
      }
    }
  }

  // Strip trailing legal entities
  name = name.replace(/\b(?:Pvt\.?|Ltd\.?|Private|Limited|LLP|LLC|Inc\.?|Corp\.?)\b/gi, '').trim();

  // Strip trailing city/country names only if preceded by space
  name = name.replace(/\s+(?:Surat|Ahmedabad|Gandhinagar|India)$/i, '').trim();

  // Clean trailing punctuation including dots
  name = name.replace(/[^a-zA-Z0-9)]+$/g, '').trim();

  return name || raw.trim();
}

/**
 * Parses and normalizes Indian compensation numbers (LPA, INR, monthly)
 */
function parseSalaryFromText(text) {
  if (!text) return null;

  let minLpa = null;
  let maxLpa = null;
  let avgLpa = null;
  let sampleCount = '';
  let rawText = '';

  // If Glassdoor comparison benchmark snippet, extract the real company salary rather than national average
  if (/\b(?:higher|lower)\s+than\s+(?:the\s+)?average\b/i.test(text) && /\b(?:estimate\)\s*in\s*India|in\s*India)\b/i.test(text)) {
    const compMatch = text.match(/(?:salary\s*of\s*)₹?\s*(\d{1,2}(?:,\d{2})*(?:,\d{3})|\d+(?:\.\d+)?\s*(?:L|LPA|Lakhs?))/i);
    if (compMatch) {
      const val = compMatch[1].replace(/,/g, '');
      const num = parseFloat(val);
      if (num > 50000) {
        avgLpa = parseFloat((num / 100000).toFixed(2));
        minLpa = avgLpa;
        maxLpa = avgLpa;
        rawText = compMatch[0];
        return { minLpa, maxLpa, avgLpa, sampleCount, rawText };
      } else if (num >= 1.0 && num <= 60) {
        avgLpa = num;
        minLpa = num;
        maxLpa = num;
        rawText = compMatch[0];
        return { minLpa, maxLpa, avgLpa, sampleCount, rawText };
      }
    }
    // Reject card to avoid hallucinating the national benchmark as company salary
    return null;
  }

  // Extract sample count if available (e.g. "based on 18 salaries", "by 70+ Employees")
  const sampleMatch = text.match(/(?:based on|from|by)\s*(\d+)\+?\s*(?:salaries|employees|profiles|ratings)/i);
  if (sampleMatch) {
    sampleCount = sampleMatch[1];
  }

  // 1. LPA Range: "₹5.1 L/yr - ₹5.7 L/yr" or "5.5 to 7.0 LPA" or "₹2.9 Lakhs to ₹3.5 Lakhs"
  const lpaRangeRegex = /(?:₹\s*(\d+(?:\.\d+)?)\s*(?:L\b|LPA\b|Lakhs?\b|Lacs?\b)?|(\d+(?:\.\d+)?)\s*(?:LPA\b|Lakhs?\b|Lacs?\b|L\/yr\b)?)\s*(?:-|–|—|to)\s*₹?\s*(\d+(?:\.\d+)?)\s*(?:LPA\b|Lakhs?\b|Lacs?\b|L\/yr\b|L\b)/i;
  const rangeMatch = text.match(lpaRangeRegex);
  if (rangeMatch) {
    const num1 = parseFloat(rangeMatch[1] || rangeMatch[2]);
    const num2 = parseFloat(rangeMatch[3]);
    if (!isNaN(num1) && !isNaN(num2) && num1 <= num2 && num1 >= 0.5 && num2 <= 80) {
      minLpa = num1;
      maxLpa = num2;
      avgLpa = parseFloat(((minLpa + maxLpa) / 2).toFixed(2));
      rawText = rangeMatch[0];
      return { minLpa, maxLpa, avgLpa, sampleCount, rawText };
    }
  }

  // 2. Monthly 'k' range: "₹37.1k to ₹37.9k per month"
  const monthlyKRange = /₹?\s*(\d+(?:\.\d+)?)\s*k\s*(?:-|–|—|to)\s*₹?\s*(\d+(?:\.\d+)?)\s*k\s*(?:per month|\/mo|pm|take-home)/i;
  const mKMatch = text.match(monthlyKRange);
  if (mKMatch) {
    const minM = parseFloat(mKMatch[1]) * 1000;
    const maxM = parseFloat(mKMatch[2]) * 1000;
    minLpa = parseFloat(((minM * 12) / 100000).toFixed(2));
    maxLpa = parseFloat(((maxM * 12) / 100000).toFixed(2));
    avgLpa = parseFloat(((minLpa + maxLpa) / 2).toFixed(2));
    rawText = mKMatch[0];
    return { minLpa, maxLpa, avgLpa, sampleCount, rawText };
  }

  // 3. Comma-separated Annual INR Range: "₹4,20,000 ... and ₹10,00,000"
  const commaRange = /₹?\s*(\d{1,2}(?:,\d{2})*(?:,\d{3}))\s*(?:\(25th percentile\))?\s*(?:and|-|–|—|to)\s*₹?\s*(\d{1,2}(?:,\d{2})*(?:,\d{3}))/i;
  const cRangeMatch = text.match(commaRange);
  if (cRangeMatch) {
    const num1 = parseInt(cRangeMatch[1].replace(/,/g, ''), 10);
    const num2 = parseInt(cRangeMatch[2].replace(/,/g, ''), 10);
    if (num1 >= 50000 && num2 >= 50000) {
      minLpa = parseFloat((num1 / 100000).toFixed(2));
      maxLpa = parseFloat((num2 / 100000).toFixed(2));
      avgLpa = parseFloat(((minLpa + maxLpa) / 2).toFixed(2));
      rawText = cRangeMatch[0];
      return { minLpa, maxLpa, avgLpa, sampleCount, rawText };
    }
  }

  // 4. Single LPA: "₹ 5.5 Lakhs per year" or "Average salary is 6.2 LPA"
  const singleLpa = /(?:₹\s*(\d+(?:\.\d+)?)\s*(?:L\b|LPA\b|Lakhs?\b|Lacs?\b)|\b(?:salary|pay|ctc|package|average|median)\s*(?:is|of|approx\.?|typically)?\s*₹?\s*(\d+(?:\.\d+)?)\s*(?:LPA\b|Lakhs?\b|Lacs?\b|L\/yr\b))/i;
  const singleMatch = text.match(singleLpa);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1] || singleMatch[2]);
    if (!isNaN(val) && val >= 1.0 && val <= 60) {
      avgLpa = val;
      minLpa = val;
      maxLpa = val;
      rawText = singleMatch[0];
      return { minLpa, maxLpa, avgLpa, sampleCount, rawText };
    }
  }

  // 5. Single comma-separated annual INR: "₹ 3,66,426"
  const singleComma = /₹\s*(\d{1,2}(?:,\d{2})*(?:,\d{3}))\s*(?:yearly|per year|\/yr|annually)?/i;
  const sCommaMatch = text.match(singleComma);
  if (sCommaMatch) {
    const num = parseInt(sCommaMatch[1].replace(/,/g, ''), 10);
    if (num >= 80000 && num <= 50000000) {
      avgLpa = parseFloat((num / 100000).toFixed(2));
      minLpa = avgLpa;
      maxLpa = avgLpa;
      rawText = sCommaMatch[0];
      return { minLpa, maxLpa, avgLpa, sampleCount, rawText };
    }
  }

  return null;
}

/**
 * Validates role against strictly accepted engineering roles and rejects UI/UX, BA, QA, etc.
 */
function evaluateRole(text) {
  if (!text) return { isAllowed: false, roleName: '' };
  const lower = text.toLowerCase();

  // EXCLUSIONS: UI/UX, BA, QA, Sales, etc.
  const excludePatterns = [
    /\bui[\s/_-]*ux\b/i,
    /\bux[\s/_-]*ui\b/i,
    /\buser experience\b/i,
    /\buser interface\b/i,
    /\bproduct designer\b/i,
    /\bgraphic designer\b/i,
    /\bweb designer\b/i,
    /\bbusiness analyst\b/i,
    /\bdata analyst\b/i,
    /\bsystem analyst\b/i,
    /\bproduct manager\b/i,
    /\bproject manager\b/i,
    /\bqa\b/i,
    /\bquality assurance\b/i,
    /\btester\b/i,
    /\btest engineer\b/i,
    /\bhuman resources\b/i,
    /\bhr\b/i,
    /\brecruiter\b/i,
    /\bmarketing\b/i,
    /\bsales\b/i,
    /\bcontent writer\b/i,
    /\bseo\b/i
  ];

  for (const ex of excludePatterns) {
    if (ex.test(lower)) {
      return { isAllowed: false, roleName: '' };
    }
  }

  // INCLUSIONS: Software Engineering, SDE, Full Stack, Frontend, Backend
  if (/\b(?:sde|sde[\s-]*[1i]|junior sde)\b/i.test(lower)) {
    return { isAllowed: true, roleName: 'Software Development Engineer (SDE)' };
  }
  if (/\bfull[\s-]*stack(?:[\s-]*developer|[\s-]*engineer)?\b/i.test(lower)) {
    return { isAllowed: true, roleName: 'Full Stack Developer' };
  }
  if (/\b(?:frontend|front[\s-]*end)(?:[\s-]*developer|[\s-]*engineer)?\b/i.test(lower)) {
    return { isAllowed: true, roleName: 'Frontend Developer' };
  }
  if (/\b(?:backend|back[\s-]*end)(?:[\s-]*developer|[\s-]*engineer)?\b/i.test(lower)) {
    return { isAllowed: true, roleName: 'Backend Developer' };
  }
  if (/\b(?:associate[\s-]*software[\s-]*engineer|junior[\s-]*software[\s-]*engineer)\b/i.test(lower)) {
    return { isAllowed: true, roleName: 'Associate Software Engineer' };
  }
  if (/\b(?:software[\s-]*engineer|software[\s-]*developer|web[\s-]*developer)\b/i.test(lower)) {
    return { isAllowed: true, roleName: 'Software Engineer' };
  }

  return { isAllowed: false, roleName: '' };
}

/**
 * Checks experience level mentioned in text
 */
function evaluateExperience(text) {
  if (!text) return 'Fresher (0-1 yrs)';
  const lower = text.toLowerCase();

  if (/\b(?:fresher|freshers|0[\s-]*1\s*yrs?|0[\s-]*2\s*yrs?|entry[\s-]*level|associate|less than 1 year|0\s*years?)\b/i.test(lower)) {
    return 'Fresher (0-1 yrs)';
  }
  if (/\b(?:1[\s-]*3\s*yrs?|junior)\b/i.test(lower)) {
    return 'Junior (1-3 yrs)';
  }
  if (/\b(?:senior|lead|architect|manager|5\+?\s*years?)\b/i.test(lower)) {
    return 'Senior (5+ yrs)';
  }

  return 'Fresher / Entry-level';
}

/**
 * Appends a verified result to the output CSV
 */
function appendResultToCsv(outputFilePath, record) {
  const row = [
    escapeCsv(record.company_name),
    escapeCsv(record.location),
    escapeCsv(record.company_website),
    escapeCsv(record.matched_role),
    escapeCsv(record.experience_level),
    escapeCsv(record.salary_min_lpa !== null ? record.salary_min_lpa : ''),
    escapeCsv(record.salary_max_lpa !== null ? record.salary_max_lpa : ''),
    escapeCsv(record.salary_avg_lpa !== null ? record.salary_avg_lpa : ''),
    escapeCsv(record.salary_raw_text),
    escapeCsv(record.qualifies_above_5lpa),
    escapeCsv(record.salary_source),
    escapeCsv(record.source_url),
    escapeCsv(record.verified_at)
  ].join(',') + '\n';

  fs.appendFileSync(outputFilePath, row, 'utf8');
}

/**
 * Checks if Google has presented a CAPTCHA/bot verification and pauses for human resolution
 */
async function checkAndHandleCaptcha(page) {
  const currentUrl = page.url();
  const isSorry = currentUrl.includes('google.com/sorry');
  const hasCaptcha = await page.$('#captcha-form, form#captcha, #recaptcha, div.g-recaptcha, iframe[src*="recaptcha"]');

  if (isSorry || hasCaptcha) {
    console.log('\n====================================================================');
    console.log('⚠️  [GOOGLE VERIFICATION / CAPTCHA DETECTED]');
    console.log('Google has temporarily paused automated requests.');
    console.log('👉 ACTION REQUIRED: Solve the CAPTCHA in the open Chromium browser window.');
    console.log('⏳ The scraper will automatically detect when solved and continue...');
    console.log('====================================================================\n');

    const timeoutMs = 180000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(2000);
      const url = page.url();
      const stillHasCaptcha = await page.$('#captcha-form, form#captcha, #recaptcha, div.g-recaptcha, iframe[src*="recaptcha"]');
      if (!url.includes('google.com/sorry') && !stillHasCaptcha) {
        console.log('\n✅ [CAPTCHA Solved!] Resuming verification scraper automatically...\n');
        await sleep(3000);
        return true;
      }
    }

    console.warn('\n[Warning] CAPTCHA was not solved within 180 seconds.');
    return false;
  }
  return true;
}

/**
 * Searches Google and parses verified salary results from AmbitionBox, Glassdoor, Indeed
 */
async function verifyCompanySalaries(page, company, minSalaryLpa) {
  const cleanName = cleanCompanyName(company.company_name);
  const query = `"${cleanName}" software engineer OR "full stack" OR "developer" salary ambitionbox OR glassdoor`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);

    // Check if Google showed a CAPTCHA
    const cleared = await checkAndHandleCaptcha(page);
    if (!cleared) {
      throw new Error('Google CAPTCHA requires manual verification.');
    }

    // If redirected back from CAPTCHA, re-navigate to the target search URL
    if (page.url().includes('google.com/sorry') || page.url().includes('sorry/index')) {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2000);
    }

    // Extract search cards from Google
    const cards = await page.$$eval('#search .g, div.MjjYud', elements => {
      return elements.map(el => {
        const titleEl = el.querySelector('h3');
        const linkEl = el.querySelector('a');
        const snippetEl = el.querySelector('[data-sncf], .VwiC3b, .yXK7lf');
        const sourceEl = el.querySelector('cite, .VuuXrf');

        return {
          title: titleEl ? titleEl.innerText : '',
          link: linkEl ? linkEl.href : '',
          sourceName: sourceEl ? sourceEl.innerText : '',
          snippet: snippetEl ? snippetEl.innerText : ''
        };
      }).filter(c => c.title && (c.snippet || c.link));
    });

    // Prioritize AmbitionBox which gives verified Indian IT company salary distributions
    cards.sort((a, b) => {
      const aIsAmbition = (a.sourceName + a.link).toLowerCase().includes('ambitionbox') ? 1 : 0;
      const bIsAmbition = (b.sourceName + b.link).toLowerCase().includes('ambitionbox') ? 1 : 0;
      return bIsAmbition - aIsAmbition;
    });

    let bestMatch = null;

    for (const card of cards) {
      const combinedText = `${card.title} ${card.snippet}`;

      // 1. Role validation (must be dev/SDE/fullstack, not UI/UX or BA)
      const roleEval = evaluateRole(combinedText);
      if (!roleEval.isAllowed) {
        continue;
      }

      // 2. Salary extraction
      const salaryParsed = parseSalaryFromText(combinedText);
      if (!salaryParsed) {
        continue;
      }

      // 3. Experience check
      const expLevel = evaluateExperience(combinedText);
      if (expLevel.startsWith('Senior')) {
        // Skip senior figures so they don't corrupt fresher data
        continue;
      }

      // 4. Source identification
      let source = 'Internet / Web';
      const sourceLower = (card.sourceName + ' ' + card.link).toLowerCase();
      if (sourceLower.includes('ambitionbox')) source = 'AmbitionBox';
      else if (sourceLower.includes('glassdoor')) source = 'Glassdoor';
      else if (sourceLower.includes('indeed')) source = 'Indeed';
      else if (sourceLower.includes('linkedin')) source = 'LinkedIn';

      const qualifies = (salaryParsed.avgLpa >= minSalaryLpa || salaryParsed.minLpa >= minSalaryLpa) ? 'YES' : 'NO';

      const candidate = {
        company_name: company.company_name,
        location: company.location,
        company_website: company.company_website,
        matched_role: roleEval.roleName,
        experience_level: expLevel,
        salary_min_lpa: salaryParsed.minLpa,
        salary_max_lpa: salaryParsed.maxLpa,
        salary_avg_lpa: salaryParsed.avgLpa,
        salary_raw_text: `${salaryParsed.rawText}${salaryParsed.sampleCount ? ` (based on ${salaryParsed.sampleCount} salaries)` : ''}`,
        qualifies_above_5lpa: qualifies,
        salary_source: source,
        source_url: card.link,
        verified_at: new Date().toISOString()
      };

      // If it qualifies above threshold, prioritize and return it immediately
      if (qualifies === 'YES') {
        return candidate;
      }

      // Otherwise retain candidate with best information
      if (!bestMatch) {
        bestMatch = candidate;
      }
    }

    if (bestMatch) {
      return bestMatch;
    }

    // No salary found
    return {
      company_name: company.company_name,
      location: company.location,
      company_website: company.company_website,
      matched_role: 'Software Engineer / SDE',
      experience_level: 'Fresher (0-1 yrs)',
      salary_min_lpa: null,
      salary_max_lpa: null,
      salary_avg_lpa: null,
      salary_raw_text: 'No verified fresher salary publicly listed',
      qualifies_above_5lpa: 'NO',
      salary_source: 'N/A',
      source_url: '',
      verified_at: new Date().toISOString()
    };

  } catch (err) {
    console.warn(`[Search] Error searching for "${cleanName}": ${err.message}`);
    return null;
  }
}

async function run() {
  console.log('================================================================');
  console.log('   Fresher Tech Salary Verification Tool (SDE / Full Stack)     ');
  console.log('================================================================\n');

  const config = loadConfig();
  console.log(`[Config] Input CSV: ${config.inputFile}`);
  console.log(`[Config] Output CSV: ${config.outputFile}`);
  console.log(`[Config] Minimum Salary Threshold: >= ${config.minSalaryLpa} LPA`);
  console.log(`[Config] Headless Mode: ${config.headless}`);
  console.log(`[Config] Delay Between Searches: ${config.delayBetweenRequestsMs}ms\n`);

  const processedKeys = initOutputCsv(config.outputFile);
  const companies = readInputCsv(config.inputFile);

  console.log(`[Input] Total companies loaded from input: ${companies.length}`);

  const remaining = companies.filter(c => !processedKeys.has(c.company_name.trim().toLowerCase()));
  console.log(`[Resume] Companies remaining to verify: ${remaining.length}\n`);

  if (remaining.length === 0) {
    console.log('[Done] All companies in the input file have already been processed.');
    return;
  }

  const limit = (typeof config.maxCompanies === 'number' && config.maxCompanies > 0)
    ? Math.min(config.maxCompanies, remaining.length)
    : remaining.length;

  console.log('[Browser] Launching browser...');
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

  let verifiedQualifyingCount = 0;
  let verifiedProcessedCount = 0;

  try {
    for (let i = 0; i < limit; i++) {
      const comp = remaining[i];
      const progressStr = `[${i + 1}/${limit}]`;
      const cleanName = cleanCompanyName(comp.company_name);

      console.log(`\n--------------------------------------------------------------`);
      console.log(`${progressStr} Checking: "${comp.company_name}" (Query: "${cleanName}")`);

      const result = await verifyCompanySalaries(page, comp, config.minSalaryLpa);

      if (result) {
        verifiedProcessedCount++;
        processedKeys.add(comp.company_name.trim().toLowerCase());

        const qualifies = result.qualifies_above_5lpa === 'YES';
        if (qualifies) {
          verifiedQualifyingCount++;
        }

        // Check if config wants only qualifying records or all records
        if (!config.includeOnlyQualifying || qualifies) {
          appendResultToCsv(config.outputFile, result);
        }

        const tag = qualifies ? '[QUALIFIES >= 5 LPA]' : '[BELOW 5 LPA / UNLISTED]';
        console.log(`${tag} Role: ${result.matched_role} | Salary: ${result.salary_avg_lpa ? result.salary_avg_lpa + ' LPA' : 'N/A'} | Source: ${result.salary_source}`);
        if (result.salary_raw_text) {
          console.log(`       Details: ${result.salary_raw_text}`);
        }
      }

      // Natural human-like jitter delay between requests (base delay + 1s - 3s)
      const jitter = Math.floor(Math.random() * 2000) + 1000;
      await sleep(config.delayBetweenRequestsMs + jitter);
    }

    console.log(`\n==============================================================`);
    console.log(`[Summary] Salary Verification Completed!`);
    console.log(`[Total Processed] ${verifiedProcessedCount} companies verified`);
    console.log(`[Qualifying >= ${config.minSalaryLpa} LPA] ${verifiedQualifyingCount} companies`);
    console.log(`[Output Saved] Results recorded at: ${config.outputFile}`);
    console.log(`==============================================================\n`);

  } catch (err) {
    console.error(`[Fatal] Verification run encountered an error: ${err.message}`);
  } finally {
    console.log('[Browser] Closing browser...');
    await browser.close().catch(() => {});
  }
}

run();
