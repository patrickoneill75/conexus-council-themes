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
    description: "Themes and benchmarks from each quarter's post-meeting survey.",
    baseUrl: "/council-data",
    controlPanelUrl: "/council-data/control-panel",
  },
  {
    id: "mcm",
    name: "Manufacturing Conditions Monitor",
    description: "Quarterly headwinds and tailwinds for U.S. manufacturing, read from SEC filings.",
    baseUrl: "/mcm",
    controlPanelUrl: "/mcm/control-panel",
  },
  {
    // id stays "pcn" -- it's an internal identifier (the app-visibility KV key, the
    // Worker's /api/pcn/* mount in src/pcn.js) that predates this rebrand and isn't
    // shown anywhere; only the user-facing name/baseUrl/controlPanelUrl changed.
    id: "pcn",
    name: "Issue Network Mapper",
    description: "A growing map of how members believe their problems connect, built from meeting notes, with the evidence behind each link.",
    baseUrl: "/inm",
    controlPanelUrl: "/inm/control-panel",
  },
  {
    id: "consensus",
    name: "Consensus",
    description: "Chat-style surveys with follow-up questions, analyzed into ranked themes. Each survey has its own link, set up in the control panel.",
    baseUrl: "/consensus",
    controlPanelUrl: "/consensus/control-panel",
  },
  {
    // id stays "stars" -- matches the original private repo's own naming
    // ("STARs Talent Transfer API"), ported in as-is.
    id: "stars",
    name: "STARs Talent Transfer Explorer",
    description: "Which occupations share a job's skills, with Indiana wages, for employers looking for talent and workers looking for higher-paying paths.",
    baseUrl: "/stars",
    controlPanelUrl: "/stars/control-panel",
  },
  {
    id: "artifacts",
    name: "Artifact Catalogue",
    description: "A curated list of Claude artifact links, each shown publicly or privately.",
    baseUrl: "/artifacts",
    controlPanelUrl: "/artifacts/control-panel",
  },
  {
    id: "job-description",
    name: "Job Description Updater",
    description: "Walks an employer through updating a job description with the Conexus Job Description Toolkit, in about 15 minutes.",
    baseUrl: "/job-description",
    controlPanelUrl: "/job-description/control-panel",
  },
  {
    id: "apprenticeship",
    name: "Apprenticeship Readiness Toolbox",
    description: "Step-by-step self-assessments for employers: a scored readiness chat, then a workforce needs assessment.",
    baseUrl: "/apprenticeship",
    controlPanelUrl: "/apprenticeship/control-panel",
  },
  {
    id: "partner-intel",
    name: "Partner Intelligence",
    description: "Staff only. What partners are stuck on and who can help, from every meeting note in Box: trending topics, programs, company profiles and Ask.",
    baseUrl: "/partner-intel",
    controlPanelUrl: "/partner-intel/control-panel",
  },
];
