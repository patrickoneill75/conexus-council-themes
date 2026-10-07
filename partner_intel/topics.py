"""The fixed issue topics every insight is filed under.

The list is deliberately short and stable. Counting "which issues are shared" needs one
agreed label per issue, and the old export had 889 different labels across 972 rows. The model
picks from this list while it reads the note; an insight that fits none is filed as "other".

Changing the list changes extraction prompts, so PROMPT_VERSION in extract.py must be bumped
with it. An admin can rename or merge topics from the control panel without touching this file
(src/partner_intel.js applies those overrides when it reads the data).
"""
from __future__ import annotations

TOPICS = [
    ("talent_pipeline", "Talent pipeline and recruiting",
     "recruit hiring hire candidates labor shortage open roles applicants cdl drivers job fair"),
    ("apprenticeship", "Apprenticeship and training programs",
     "apprentice apprenticeship training program internship cohort earn and learn onboarding curriculum"),
    ("retention_compensation", "Retention, wages and benefits",
     "retention turnover wages pay benefits compensation culture engagement attrition"),
    ("aging_workforce", "Aging workforce and succession of skills",
     "retire retirement aging workforce knowledge transfer succession vacant machinists"),
    ("skills_gap", "Skills gaps and upskilling",
     "skills upskilling reskilling competency certification credential skills library"),
    ("ai_adoption", "AI adoption and governance",
     "ai artificial intelligence copilot claude chatgpt llm machine learning governance guardrails"),
    ("automation_robotics", "Automation and robotics",
     "automation robot robotics cobot amr pick and place automated"),
    ("systems_data", "ERP, MES and data integration",
     "erp mes netsuite data integration software system dashboard analytics scheduling software"),
    ("cybersecurity_it", "Cybersecurity and IT",
     "cyber security cybersecurity it infrastructure network breach ransomware compliance cmmc"),
    ("quality", "Quality systems and inspection",
     "quality inspection defect scrap iso audit measurement metrology spc"),
    ("maintenance_equipment", "Maintenance and equipment",
     "maintenance predictive downtime equipment machine repair spare parts capital equipment"),
    ("production_planning", "Production scheduling and planning",
     "scheduling planning capacity throughput constraint changeover forecasting inventory"),
    ("lean_improvement", "Lean and continuous improvement",
     "lean continuous improvement kaizen process improvement waste efficiency productivity"),
    ("raw_materials", "Raw material cost and supply",
     "raw material steel resin aluminum copper commodity price volatility supplier shortage"),
    ("supply_chain_logistics", "Supply chain and logistics",
     "supply chain logistics freight shipping transportation warehouse distribution lead time"),
    ("tariffs_trade", "Tariffs and trade",
     "tariff tariffs trade duty import export refund surcharge customs"),
    ("onshoring", "On-shoring and sourcing strategy",
     "onshoring on-shoring reshoring nearshoring offshore sourcing domestic"),
    ("sales_growth", "Customer demand and business development",
     "customers demand sales business development new customers pipeline growth market share"),
    ("pricing_cost", "Pricing and cost pressure",
     "pricing price increase cost pressure margin inflation quoting"),
    ("capital_financing", "Capital investment and financing",
     "capital investment financing loan funding grant incentive tax abatement credit"),
    ("energy_utilities", "Energy and utilities",
     "energy electricity utility power gas rates sustainability solar"),
    ("facility_changes", "Facility expansion, closures and layoffs",
     "facility expansion closure closing layoff plant new facility relocation"),
    ("ownership_ma", "Ownership, M&A and succession",
     "acquisition merger acquire sale ownership succession private equity family business"),
    ("compliance_safety", "Regulation, compliance and safety",
     "regulation compliance osha safety environmental epa permit audit ehs"),
    ("policy_infrastructure", "Public policy and infrastructure",
     "policy legislature legislation state government infrastructure road tolling freight study incentives"),
    ("education_partnerships", "Education and school partnerships",
     "school college university ivy tech purdue high school students k-12 curriculum partnership"),
    ("peer_connections", "Peer connections and benchmarking",
     "peer benchmarking connect introduction network share best practice"),
    ("marketing_visibility", "Marketing, brand and visibility",
     "marketing brand visibility website social media trade show awareness"),
    ("innovation_rd", "Product innovation and R&D",
     "innovation research development prototype new product r&d additive manufacturing"),
    ("conexus_programs", "Conexus programs and services",
     "conexus program programs services membership council event feedback"),
]

TOPIC_IDS = [t[0] for t in TOPICS]
TOPIC_LABELS = {t[0]: t[1] for t in TOPICS}
OTHER = "other"


def topic_list_for_prompt() -> str:
    return "\n".join(f"- {tid}: {label}" for tid, label, _ in TOPICS) + f"\n- {OTHER}: none of the above"


def as_dataset() -> list[dict]:
    return [{"id": tid, "label": label, "keywords": kw} for tid, label, kw in TOPICS] + [
        {"id": OTHER, "label": "Other", "keywords": ""}]
