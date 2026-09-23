// STARs Talent Transfer Explorer's ranking/matching/skill-gap methodology --
// ported unchanged from the original private stars-api repo (itself a
// line-for-line JS port of stars_talent_transfer_explorer.py, verified
// identical output across all 873 occupations before that port shipped).
// Euclidean distance across 35 O*NET skill-importance scores is the ranking
// ("the magic sauce"), and "skill similarity" is a monotonic 0-100%
// re-expression of that same distance so the displayed percent can never
// disagree with the sort order. SKILL_ACTIONS below is a static, hand-written
// lookup table (one entry per O*NET skill) -- it does not call Claude or any
// other API; the per-request "skill gap" text is entirely deterministic math
// plus this fixed table, nothing generated live.

export const SKILL_ACTIONS = {
  "Reading Comprehension": "Read and interpret SOPs, work instructions, safety procedures, quality documents, and basic technical specifications.",
  "Active Listening": "Practice shift handoffs, supervisor instructions, safety briefings, and confirming critical information before acting.",
  "Writing": "Document production issues, inspection results, handoffs, and corrective actions clearly and consistently.",
  "Speaking": "Communicate process conditions, safety concerns, defects, and handoff information clearly with operators and supervisors.",
  "Mathematics": "Build shop-math skills: measurement, decimals/fractions, tolerances, rates, basic geometry, and production calculations.",
  "Science": "Learn the basic material, mechanical, chemical, or process principles that explain how the equipment and product behave.",
  "Critical Thinking": "Use structured problem solving to evaluate evidence, distinguish symptoms from causes, and choose corrective actions.",
  "Active Learning": "Practice applying new instructions or lessons to unfamiliar production situations and incorporating feedback quickly.",
  "Learning Strategies": "Use effective job-learning methods such as demonstrations, checklists, practice cycles, job aids, and teach-back.",
  "Monitoring": "Track work quality, process conditions, and personal/team performance; recognize when results are drifting from standard.",
  "Social Perceptiveness": "Read coworker and supervisor cues, adapt communication, and recognize when help or escalation is needed.",
  "Coordination": "Coordinate timing and handoffs with upstream/downstream workers so production, safety, and quality stay aligned.",
  "Persuasion": "Practice gaining buy-in for process, safety, or quality changes using evidence and clear reasoning.",
  "Negotiation": "Build skills for resolving competing priorities, constraints, and handoff issues while protecting production requirements.",
  "Instructing": "Learn to demonstrate tasks, explain standards, coach peers, and verify that instructions were understood.",
  "Service Orientation": "Anticipate internal/customer needs and respond reliably to requests, defects, and service problems.",
  "Complex Problem Solving": "Work through multi-step production problems using root-cause analysis, countermeasures, and verification.",
  "Operations Analysis": "Translate production requirements into the process steps, machine settings, tooling, and resources needed to do the work.",
  "Technology Design": "Understand how tooling, fixtures, controls, or work methods can be adapted to better meet production requirements.",
  "Equipment Selection": "Learn how to choose the appropriate machine, tooling, gauges, fixtures, or material-handling equipment for a task.",
  "Installation": "Practice safe setup and installation of tooling, fixtures, components, guards, and production equipment as relevant to the role.",
  "Programming": "Develop the machine, CNC, PLC, robot, or software programming skills required by the specific equipment used in the role.",
  "Operations Monitoring": "Read gauges, HMIs, indicators, sounds, cycle data, and process signals to recognize normal versus abnormal operation.",
  "Operation and Control": "Build hands-on proficiency starting, stopping, feeding, adjusting, and controlling production equipment within standard work.",
  "Equipment Maintenance": "Learn operator-level preventive maintenance, inspections, lubrication, wear checks, and escalation procedures.",
  "Troubleshooting": "Diagnose equipment or process problems from symptoms, isolate likely causes, and use a structured escalation process.",
  "Repairing": "Build the mechanical/electrical repair skills appropriate to the role, including safe replacement or adjustment of basic components.",
  "Quality Control Analysis": "Use gauges, inspection methods, sampling, tolerances, and basic SPC concepts to determine whether output meets specification.",
  "Judgment and Decision Making": "Practice choosing the safest and most effective response to defects, downtime, process variation, and competing priorities.",
  "Systems Analysis": "Understand how changes in one part of the production system affect upstream/downstream equipment, quality, throughput, and labor.",
  "Systems Evaluation": "Evaluate whether a process change actually improved safety, quality, cost, delivery, or throughput using defined measures.",
  "Time Management": "Prioritize setup, production, inspection, maintenance, and handoff tasks to meet takt, cycle-time, and schedule expectations.",
  "Management of Financial Resources": "Understand basic cost tradeoffs, scrap/rework impacts, overtime, and spending decisions relevant to the role.",
  "Management of Material Resources": "Manage material, tooling, WIP, consumables, and inventory accurately while minimizing shortages, damage, and waste.",
  "Management of Personnel Resources": "Build frontline skills in assigning work, coaching, feedback, conflict resolution, and developing other employees.",
};

// Python's string formatting (f"{x:.0f}", f"{x:.1f}") rounds ties to the
// nearest EVEN digit (banker's rounding), not away from zero like JS's
// Math.round/toFixed. Skill-importance scores sit on a 0.25 grid, so exact
// .5 ties in derived percentages (e.g. 0.25/2.0*100 = 12.5) come up often
// enough in practice that this difference is visible, not theoretical --
// this replicates Python's rounding so every displayed number matches the
// original app exactly.
//
// The tie test runs on the double's own EXACT decimal expansion, via
// toFixed(20), rather than on `value * 10**ndigits`. That multiplication
// introduces error of its own before the test ever runs: 12.35 is really
// 12.34999999999999964..., but 12.35 * 10 evaluates to 123.50000000000001,
// so testing the product reported a tie that isn't one and rounded 12.35 up
// to 12.4 where Python gives 12.3 (likewise 2.675 -> 2.68 against Python's
// 2.67). toFixed is correctly rounded from the exact binary value, so reading
// the digits off it and deciding there matches Python for ties and non-ties
// alike. BigInt keeps the reassembled integer exact for a large value such as
// an annual wage.
function pyRound(value, ndigits = 0) {
  if (!Number.isFinite(value)) return value;
  // Past 2^53 there is no fractional part left to round, and toFixed would
  // switch to exponential notation anyway.
  if (Math.abs(value) >= 1e15) return value;

  const negative = value < 0;
  const [intPart, fracPart = ""] = Math.abs(value).toFixed(20).split(".");
  const keep = fracPart.slice(0, ndigits).padEnd(ndigits, "0");
  const rest = fracPart.slice(ndigits);

  let scaled = BigInt(intPart + keep);
  const first = rest ? rest.charCodeAt(0) - 48 : 0;
  if (first > 5 || (first === 5 && /[1-9]/.test(rest.slice(1)))) {
    scaled += 1n;                            // strictly past halfway: away from zero
  } else if (first === 5 && scaled % 2n === 1n) {
    scaled += 1n;                            // an exact tie: to even, as Python does
  }
  const rounded = Number(scaled) / Math.pow(10, ndigits);
  return negative ? -rounded : rounded;
}

// Matches Python's html.escape(s, quote=True), which is what the original
// app applies to every occupation/skill name injected into a Markdown
// string (Gradio's Markdown component renders raw HTML, so this keeps a
// title like "Police and Sheriff's Patrol Officers" from being interpreted
// as markup and displays consistently with the original app).
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function currency(value) {
  if (value === null || value === undefined) return "N/A";
  return `$${pyRound(value, 0).toLocaleString("en-US")}`;
}

export function pct(value) {
  if (value === null || value === undefined) return "N/A";
  return `${pyRound(value, 1).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// distance: the original STARs ranking methodology (unchanged) -- Euclidean
// distance across all 35 O*NET skill-importance scores. Smaller distance =
// closer skill profile.
//
// similarity: a human-readable 0-100% re-expression of that SAME distance.
// O*NET importance ratings run 1-5, so the largest possible per-skill gap is
// 4 and the largest possible distance across N skills is sqrt(N * 4^2). We
// scale distance against that maximum so 100% = identical profile, 0% = the
// most different two profiles can be. Because similarity is a strictly
// decreasing function of distance, sorting by distance and sorting by
// similarity always produce the same order.
export function distanceAndMatch(targetVec, sourceVec) {
  let sumSq = 0;
  for (let i = 0; i < targetVec.length; i++) {
    const d = targetVec[i] - sourceVec[i];
    sumSq += d * d;
  }
  const distance = Math.sqrt(sumSq);

  const maxPerSkillGap = 4.0;
  const maxDistance = Math.sqrt(targetVec.length) * maxPerSkillGap;
  const similarity =
    maxDistance > 0
      ? Math.max(0, Math.min(100, 100 * (1 - distance / maxDistance)))
      : 100.0;

  return { distance, similarity };
}

// A "gap" is directional: target skill importance - source skill importance.
// Only positive gaps are shown -- those are skills the worker's current
// occupation is less likely to have emphasized than the target job.
export function buildSkillGapRows(targetOcc, sourceOcc, skills, limit = 8) {
  if (!targetOcc || !sourceOcc) {
    return {
      rows: [],
      note: "Click a transfer occupation in the left table to see its skill gaps.",
    };
  }

  const gaps = [];
  const strengths = [];

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const targetScore = targetOcc.vector[i];
    const sourceScore = sourceOcc.vector[i];
    const rawGap = targetScore - sourceScore;

    if (rawGap > 0) {
      const gapPct = targetScore > 0 ? (rawGap / targetScore) * 100.0 : 0.0;
      gaps.push({ skill, target: targetScore, source: sourceScore, gap: rawGap, gapPct });
    }

    if (targetScore >= 2.75 && sourceScore >= targetScore - 0.25) {
      strengths.push([targetScore, sourceScore, skill]);
    }
  }

  // Default ordering: highest displayed percentage gap to lowest.
  gaps.sort((a, b) => b.gapPct - a.gapPct || b.gap - a.gap || b.target - a.target);
  const top = gaps.slice(0, limit);

  const rows = top.map((g) => [
    g.skill,
    `${pyRound(g.gapPct, 0)}%`,
    SKILL_ACTIONS[g.skill] || `Provide targeted practice and coaching in ${g.skill.toLowerCase()}.`,
  ]);

  strengths.sort((a, b) => b[0] - a[0] || b[1] - a[1] || (a[2] < b[2] ? 1 : -1));
  const strengthNames = strengths.slice(0, 4).map((s) => s[2]);

  let note;
  if (strengthNames.length) {
    note =
      `**Strongest transferable skills:** ${escapeHtml(strengthNames.join(", "))}.  \n` +
      `**Largest skill gaps:** ` +
      (top.length ? top.slice(0, 4).map((g) => escapeHtml(g.skill)).join(", ") : "No positive gaps identified.");
  } else {
    note =
      "**Strongest transferable skills:** The model does not show a strong overlap " +
      "among the target job's higher-importance skills.  \n" +
      "**Development need:** Expect a more substantial training ramp.";
  }

  note +=
    "  \n\n*Skill gaps are occupation-level signals, not an assessment of an individual worker. " +
    "Validate them against the actual equipment, SOPs, credentials, and safety requirements at your facility.*";

  return { rows, note };
}

function clampResultCount(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n)) n = 20;
  return Math.max(5, Math.min(50, n));
}

// Employer-facing: rank other occupations against a target the employer
// needs to fill.
export function findTransfers({ targetTitle, lowerWageOnly, resultCount }, occByTitle, occupations, skills) {
  const target = occByTitle[targetTitle];
  if (!target) {
    return {
      targetSummary: "Select a target occupation.",
      rows: [],
      resultTitles: [],
      gapHeading: "### Skills gap",
      gapRows: [],
      gapNote: "Choose a target occupation first.",
    };
  }

  const targetWage = target.annualWage;
  resultCount = clampResultCount(resultCount);

  let wageFilterWarning = "";
  let effectiveLowerWageOnly = Boolean(lowerWageOnly);
  if (targetWage === null && effectiveLowerWageOnly) {
    effectiveLowerWageOnly = false;
    wageFilterWarning =
      " This target occupation does not have a matched Indiana annual median wage " +
      "in the workbook, so the lower-wage filter was ignored.";
  }

  const matches = [];
  for (const source of occupations) {
    if (source.title === targetTitle) continue;

    const sourceWage = source.annualWage;
    if (effectiveLowerWageOnly) {
      if (sourceWage === null || targetWage === null || sourceWage >= targetWage) continue;
    }

    let wageGainPct = null;
    if (sourceWage !== null && targetWage !== null && sourceWage > 0) {
      wageGainPct = ((targetWage - sourceWage) / sourceWage) * 100.0;
    }

    const { distance, similarity } = distanceAndMatch(target.vector, source.vector);
    matches.push({ source, distance, similarity, wageGainPct });
  }

  // Preserve the original STARs ranking methodology: Euclidean distance,
  // smallest first. Skill similarity is a direct percent re-expression of
  // this same distance, so this order and the displayed percent agree.
  matches.sort((a, b) => a.distance - b.distance);
  const top = matches.slice(0, resultCount);

  const rows = top.map((m) => [
    m.source.title,
    `${pyRound(m.similarity, 1).toFixed(1)}%`,
    currency(m.source.annualWage),
    pct(m.wageGainPct),
  ]);

  const targetSummary =
    `### Target occupation\n` +
    `**${escapeHtml(target.title)}**  \n` +
    `Indiana annual median wage: **${currency(targetWage)}**  \n\n` +
    `Showing **${top.length}** closest occupations.${wageFilterWarning}`;

  const resultTitles = top.map((m) => m.source.title);
  const firstChoice = resultTitles[0] || null;

  let gapHeading, gapRows, gapNote;
  if (firstChoice) {
    const built = buildSkillGapRows(target, occByTitle[firstChoice], skills);
    gapRows = built.rows;
    gapNote = built.note;
    gapHeading = `### Skills gap\n**${escapeHtml(firstChoice)} → ${escapeHtml(targetTitle)}**`;
  } else {
    gapRows = [];
    gapNote =
      "No occupations met the current filter. Turn off the lower-wage filter or increase the result range.";
    gapHeading = "### Skills gap";
  }

  return { targetSummary, rows, resultTitles, gapHeading, gapRows, gapNote };
}

// Worker-facing: rank potential next occupations from a worker's current job.
export function findHigherWageTransfers({ currentTitle, higherWageOnly, resultCount }, occByTitle, occupations, skills) {
  const current = occByTitle[currentTitle];
  if (!current) {
    return {
      currentSummary: "Select your current occupation.",
      rows: [],
      resultTitles: [],
      gapHeading: "### Skills to build",
      gapRows: [],
      gapNote: "Choose your current occupation first.",
    };
  }

  const currentWage = current.annualWage;
  resultCount = clampResultCount(resultCount);

  let wageFilterWarning = "";
  let effectiveHigherWageOnly = Boolean(higherWageOnly);
  if (currentWage === null && effectiveHigherWageOnly) {
    effectiveHigherWageOnly = false;
    wageFilterWarning =
      " This occupation does not have a matched Indiana annual median wage " +
      "in the workbook, so the higher-wage filter was ignored.";
  }

  const matches = [];
  for (const target of occupations) {
    if (target.title === currentTitle) continue;

    const targetWage = target.annualWage;
    if (effectiveHigherWageOnly) {
      if (targetWage === null || currentWage === null || targetWage <= currentWage) continue;
    }

    let wageGainPct = null;
    if (currentWage !== null && targetWage !== null && currentWage > 0) {
      wageGainPct = ((targetWage - currentWage) / currentWage) * 100.0;
    }

    const { distance, similarity } = distanceAndMatch(current.vector, target.vector);
    matches.push({ target, distance, similarity, wageGainPct });
  }

  matches.sort((a, b) => a.distance - b.distance);
  const top = matches.slice(0, resultCount);

  const rows = top.map((m) => [
    m.target.title,
    `${pyRound(m.similarity, 1).toFixed(1)}%`,
    currency(m.target.annualWage),
    pct(m.wageGainPct),
  ]);

  const currentSummary =
    `### Current occupation\n` +
    `**${escapeHtml(current.title)}**  \n` +
    `Indiana annual median wage: **${currency(currentWage)}**  \n\n` +
    `Showing **${top.length}** closest career options.${wageFilterWarning}`;

  const resultTitles = top.map((m) => m.target.title);
  const firstChoice = resultTitles[0] || null;

  let gapHeading, gapRows, gapNote;
  if (firstChoice) {
    const built = buildSkillGapRows(occByTitle[firstChoice], current, skills);
    gapRows = built.rows;
    gapNote = built.note;
    gapHeading = `### Skills to build\n**${escapeHtml(currentTitle)} → ${escapeHtml(firstChoice)}**`;
  } else {
    gapRows = [];
    gapNote =
      "No occupations met the current filter. Turn off the higher-wage filter or increase the result range.";
    gapHeading = "### Skills to build";
  }

  return { currentSummary, rows, resultTitles, gapHeading, gapRows, gapNote };
}

// Clicking a row in the employer-side results table re-runs the skills-gap
// panel for that specific transfer occupation, against the target the
// table was actually built for (never a since-changed dropdown value --
// the frontend must pass back the same targetTitle it received when the
// table was generated, mirroring the gr.State snapshot in the Python app).
export function skillGapForEmployerClick({ resultTitles, targetTitle, rowIndex }, occByTitle, skills) {
  if (!resultTitles || !resultTitles.length || !targetTitle) {
    return {
      gapHeading: "### Skills gap",
      gapRows: [],
      gapNote: "Run the occupation search first.",
    };
  }
  if (rowIndex < 0 || rowIndex >= resultTitles.length) {
    return {
      gapHeading: "### Skills gap",
      gapRows: [],
      gapNote: "Click a transfer occupation row to compare its skill gaps.",
    };
  }

  const sourceTitle = resultTitles[rowIndex];
  const built = buildSkillGapRows(occByTitle[targetTitle], occByTitle[sourceTitle], skills);
  return {
    gapHeading: `### Skills gap\n**${escapeHtml(sourceTitle)} → ${escapeHtml(targetTitle)}**`,
    gapRows: built.rows,
    gapNote: built.note,
  };
}

// Same idea for the worker-side "skills to build" panel.
export function skillGapForWorkerClick({ resultTitles, currentTitle, rowIndex }, occByTitle, skills) {
  if (!resultTitles || !resultTitles.length || !currentTitle) {
    return {
      gapHeading: "### Skills to build",
      gapRows: [],
      gapNote: "Run the career search first.",
    };
  }
  if (rowIndex < 0 || rowIndex >= resultTitles.length) {
    return {
      gapHeading: "### Skills to build",
      gapRows: [],
      gapNote: "Click a potential occupation row to compare its skill gaps.",
    };
  }

  const targetTitle = resultTitles[rowIndex];
  const built = buildSkillGapRows(occByTitle[targetTitle], occByTitle[currentTitle], skills);
  return {
    gapHeading: `### Skills to build\n**${escapeHtml(currentTitle)} → ${escapeHtml(targetTitle)}**`,
    gapRows: built.rows,
    gapNote: built.note,
  };
}
