/**
 * The one shared registry of every mini app on Connector -- loaded by both the public
 * grid (public/index.html) and the admin hub (public/admin/index.html), so the two
 * pages can never drift out of sync with each other.
 *
 * Convention: every app's public-ready page lives at its own base path (`baseUrl`);
 * its control panel always lives at `<baseUrl>/control-panel` and is always gated by
 * the shared beta-account system (see src/beta_auth.js) -- no app-specific passwords.
 *
 * This file only lists what exists and where. Whether an app's base page is currently
 * shown on the public grid (and, for "admin-only", whether it's gated at all) is a
 * separate, KV-backed setting -- see GET/POST /api/beta/app-visibility in
 * src/beta_auth.js -- deliberately not baked into this static file, since that's a
 * setting admins change at runtime from Settings, not a code change.
 */
const APPS = [
  {
    id: "council-data",
    name: "Council Meeting Survey Dashboard",
    description: "Council Meeting theme extraction (Claude) and quant benchmarking, " +
      "built from each quarter's post-meeting survey export.",
    baseUrl: "/council-data",
    controlPanelUrl: "/council-data/control-panel",
  },
  {
    id: "mcm",
    name: "Manufacturing Conditions Monitor",
    description: "Quarterly headwinds/tailwinds dashboard for U.S. manufacturing, " +
      "extracted from SEC EDGAR filings (Claude) and updated on demand from its own " +
      "control panel.",
    baseUrl: "/mcm",
    controlPanelUrl: "/mcm/control-panel",
  },
  {
    // id stays "pcn" -- it's an internal identifier (the app-visibility KV key, the
    // Worker's /api/pcn/* mount in src/pcn.js) that predates this rebrand and isn't
    // shown anywhere; only the user-facing name/baseUrl/controlPanelUrl changed.
    id: "pcn",
    name: "Issue Network Mapper",
    description: "Extracts causal statements from meeting notes/transcripts into an " +
      "accumulating, evidence-traceable map of how members believe their problems " +
      "connect.",
    baseUrl: "/inm",
    controlPanelUrl: "/inm/control-panel",
  },
  {
    id: "consensus",
    name: "Consensus",
    description: "Chatbot-style surveys with Claude-generated follow-up questions, " +
      "analyzed into prioritized themes once responses are in. No single public URL -- " +
      "each survey gets its own respondent link from the control panel.",
    baseUrl: "/consensus",
    controlPanelUrl: "/consensus/control-panel",
  },
  {
    // id stays "stars" -- matches the original private repo's own naming
    // ("STARs Talent Transfer API"), ported in as-is.
    id: "stars",
    name: "STARs Talent Transfer Explorer",
    description: "Ranks occupations by O*NET skill-profile similarity plus Indiana wage " +
      "data, for employers screening transferable talent pools and workers exploring " +
      "higher-wage career pathways. No Claude call anywhere in the request path.",
    baseUrl: "/stars",
    controlPanelUrl: "/stars/control-panel",
  },
];
