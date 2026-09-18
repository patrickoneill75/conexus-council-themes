"""Shared configuration. Everything tunable lives here."""
from __future__ import annotations
import os
from pathlib import Path

# ---------------------------------------------------------------- models
# Verify current model IDs at https://docs.claude.com/en/docs/about-claude/models
EXTRACTION_MODEL = os.environ.get("EXTRACTION_MODEL", "claude-haiku-4-5")
NARRATIVE_MODEL = os.environ.get("NARRATIVE_MODEL", "claude-sonnet-4-5")

# ---------------------------------------------------------------- coverage
MIN_YEAR = 2024
# SIC 2000-3999 is the SEC's manufacturing range. This is the hard gate; see
# mcm.extract.assert_manufacturing_only.
MANUFACTURING_SIC_MIN = 2000
MANUFACTURING_SIC_MAX = 3999

SEC_RPS = 4.0                      # below SEC's fair-access ceiling
QUARTERLY_COMPLETENESS_DAYS = 50   # 45-day 10-Q deadline + 5-day 12b-25 extension
ANNUAL_COMPLETENESS_DAYS = 105     # 90-day 10-K deadline + 15-day 12b-25 extension

MAX_SIGNALS_PER_FILING = 8
MAX_PARAGRAPHS_PER_FILING = 40     # main token lever for the per-filing pass
ANALYSIS_WORKERS = 4
DOWNLOAD_WORKERS = 6

# The narrative is generated for these cuts only (one set of four sections each).
# Adding a cut costs one more Sonnet call per section per quarter.
NARRATIVE_CUTS = [
    {"key": "national", "label": "All U.S. manufacturing", "state": None},
    {"key": "indiana", "label": "Indiana-headquartered manufacturers", "state": "IN"},
]
NARRATIVE_SECTIONS = ["this_quarter", "looking_ahead", "quarter_over_quarter", "year_over_year"]

# ---------------------------------------------------------------- paths
REPO_ROOT = Path(__file__).resolve().parent.parent
WORK_DIR = Path(os.environ.get("MCM_WORK_DIR", REPO_ROOT / ".work"))
# The durable store lives in Box (see mcm.box_store), not in this git repo. DATA_DIR is
# only a local mirror of it -- downloaded at the start of a run, uploaded at the end --
# so it lives under WORK_DIR (gitignored) rather than at the repo root.
DATA_DIR = WORK_DIR / "data"
RAW_FILING_DIR = WORK_DIR / "raw_filings"   # not committed; re-fetchable from SEC
CACHE_DIR = WORK_DIR / "cache"

# The mini app's own subtree under public/, served by this repo's single Cloudflare
# Worker alongside Council Themes/Quant/PCN/Consensus (see mcm.site).
# public/mcm/control-panel/index.html is hand-maintained and never overwritten by a
# publish run; everything directly under public/mcm/ (including the generated
# index.html this pipeline writes) is generated.
SITE_PUBLIC_DIR = REPO_ROOT / "public" / "mcm"

FILINGS_CSV = DATA_DIR / "filings.csv"
PARAGRAPHS_CSV = DATA_DIR / "paragraphs.csv"
SIGNALS_CSV = DATA_DIR / "signals.csv"
COMPANIES_CSV = DATA_DIR / "companies.csv"
NARRATIVES_JSON = DATA_DIR / "narratives.json"
STATUS_JSON = DATA_DIR / "status.json"

# Every file mcm.box_store syncs. Order doesn't matter; box_store addresses each by name.
BOX_DATA_FILES = [FILINGS_CSV, PARAGRAPHS_CSV, SIGNALS_CSV, COMPANIES_CSV,
                  NARRATIVES_JSON, STATUS_JSON]

for _d in (DATA_DIR, WORK_DIR, RAW_FILING_DIR, CACHE_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- Box (durable storage)
# Box login (OAuth 2.0, "Log in with Box") is this repo's single shared connection --
# the same one every other mini app here uses (see src/worker.js's box/authorize-url,
# box/callback, box/status) -- not a Box app of MCM's own. src/mcm.js holds a dedicated
# KV key for MCM's own destination folder (separate from Council Themes/Quant's Data
# Folder and from any PCN project's folder) and picks it via its own control panel.
# This script never talks to Box directly: it calls the Worker's relay endpoint,
# GET /api/mcm/relay/pipeline-token, authenticated by a shared secret, to get a
# short-lived access token plus MCM's chosen folder ID for the duration of a run. See
# SETUP.md for how this is wired up. When unset, scripts fall back to whatever is
# already in DATA_DIR locally, which is what makes local development without Box work.
BOX_RELAY_URL = os.environ.get("BOX_RELAY_URL", "").strip()
BOX_RELAY_SECRET = os.environ.get("BOX_RELAY_SECRET", "").strip()

# ---------------------------------------------------------------- taxonomy
CATEGORIES = [
    "Demand & Orders", "Customer / End-Market Conditions", "Tariffs & Trade",
    "Pricing Power", "Input Costs & Raw Materials", "Labor & Workforce",
    "Supply Chain & Logistics", "Inventories & Destocking", "Interest Rates & Financing",
    "Capital Investment", "Energy & Utilities", "Regulation & Policy",
    "FX & Global Markets", "Capacity & Utilization", "Technology & Automation",
    "Productivity", "Other Economic Condition",
]
DIRECTIONS = ["Headwind", "Tailwind", "Mixed"]
SCOPE_WEIGHT = {
    "Economy-wide": 1.00, "Manufacturing-wide": 1.00,
    "Industry-specific": 0.85, "Company-specific": 0.35,
}

SIC2_TITLES = {
    "20": "Food and Kindred Products", "21": "Tobacco Products",
    "22": "Textile Mill Products", "23": "Apparel and Other Textile Products",
    "24": "Lumber and Wood Products", "25": "Furniture and Fixtures",
    "26": "Paper and Allied Products", "27": "Printing, Publishing, and Allied Industries",
    "28": "Chemicals and Allied Products", "29": "Petroleum Refining and Related Industries",
    "30": "Rubber and Miscellaneous Plastics Products", "31": "Leather and Leather Products",
    "32": "Stone, Clay, Glass, and Concrete Products", "33": "Primary Metal Industries",
    "34": "Fabricated Metal Products", "35": "Industrial Machinery and Computer Equipment",
    "36": "Electronic and Other Electrical Equipment", "37": "Transportation Equipment",
    "38": "Measuring, Medical, Optical, and Control Instruments",
    "39": "Miscellaneous Manufacturing Industries",
}

STATE_TITLES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan",
    "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota",
    "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee",
    "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "PR": "Puerto Rico", "VI": "U.S. Virgin Islands", "GU": "Guam",
}

ECONOMIC_KEYWORDS = [
    "demand", "orders", "backlog", "volume", "customer", "end market", "market conditions",
    "tariff", "trade", "import", "export", "duties", "china", "mexico", "canada",
    "price", "pricing", "inflation", "deflation", "cost", "commodity", "raw material",
    "steel", "aluminum", "resin", "copper", "energy", "electricity", "natural gas",
    "labor", "workforce", "wage", "hiring", "turnover", "availability", "overtime",
    "supply chain", "supplier", "logistics", "freight", "shipping", "lead time",
    "inventory", "destock", "restock", "channel", "interest rate", "financing", "credit",
    "capital spending", "capital expenditure", "capex", "investment", "capacity", "utilization",
    "automation", "productivity", "regulation", "policy", "foreign exchange", "currency",
    "recession", "economic", "macroeconomic", "uncertainty", "softening", "strengthening",
]
# Forward-looking cues, used to build the "Looking Ahead" section from language that
# is actually about the future rather than the quarter just reported.
FORWARD_LOOKING_KEYWORDS = [
    "expect", "anticipate", "outlook", "guidance", "forecast", "project", "plan to",
    "will likely", "believe", "intend", "coming quarters", "next year", "remainder of",
    "going forward", "future", "upcoming", "estimate", "target", "should", "headed",
]
