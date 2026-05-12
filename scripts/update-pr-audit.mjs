import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const START = "<!-- PR-AUDIT:START -->";
const END = "<!-- PR-AUDIT:END -->";

const USER = process.env.GITHUB_USER || process.env.GITHUB_REPOSITORY_OWNER;
const README_PATH = process.env.README_PATH || "README.md";

const MERGED_SINCE = process.env.MERGED_SINCE || daysAgo(730);
const OPEN_SINCE = process.env.OPEN_SINCE || daysAgo(90);
const OPEN_FILTER = process.env.OPEN_FILTER === "created" ? "created" : "updated";

const MAX_FETCH = Number(process.env.MAX_FETCH || 1000);
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 250);
const SHOW_MERGED = Number(process.env.SHOW_MERGED || 6);
const SHOW_OPEN = Number(process.env.SHOW_OPEN || 6);

if (!USER) {
  throw new Error("Missing GITHUB_USER or GITHUB_REPOSITORY_OWNER.");
}

const searchFields = [
  "author",
  "body",
  "closedAt",
  "commentsCount",
  "createdAt",
  "id",
  "isDraft",
  "labels",
  "number",
  "repository",
  "state",
  "title",
  "updatedAt",
  "url"
].join(",");

const prViewFields = [
  "additions",
  "deletions",
  "changedFiles",
  "mergedAt",
  "reviewDecision",
  "mergeStateStatus",
  "isDraft",
  "labels",
  "body"
].join(",");

main();

function main() {
  const mergedRaw = searchMergedPrs();
  const openRaw = searchOpenPrs();

  const merged = enrichPrs(mergedRaw, "merged").sort(sortMergedDesc);
  const open = enrichPrs(openRaw, "open").sort(sortUpdatedDesc);

  const generatedAt = new Date().toISOString();
  const techCounts = countTech([...merged, ...open]);
  const reposTouched = new Set([...merged, ...open].map((p) => p.repo).filter(Boolean)).size;

  const audit = {
    generatedAt,
    user: USER,
    ranges: {
      mergedSince: MERGED_SINCE,
      openSince: OPEN_SINCE,
      openFilter: OPEN_FILTER
    },
    summary: {
      mergedCount: merged.length,
      openCount: open.length,
      reposTouched,
      topTech: Object.entries(techCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 12)
        .map(([name, count]) => ({ name, count }))
    },
    merged,
    open
  };

  mkdirSync("data", { recursive: true });
  writeFileSync("data/pr-audit.json", `${JSON.stringify(audit, null, 2)}\n`);
  writeFileSync("PR_AUDIT.md", `${buildFullAudit(audit)}\n`);
  updateReadme(buildReadmeSection(audit));

  console.log(`Generated PR audit for ${USER}`);
  console.log(`Merged PRs: ${merged.length}`);
  console.log(`Open PRs: ${open.length}`);
}

function searchMergedPrs() {
  return ghJson([
    "search",
    "prs",
    "--author",
    USER,
    "--merged",
    "--merged-at",
    `>=${MERGED_SINCE}`,
    "--archived=false",
    "--sort",
    "updated",
    "--order",
    "desc",
    "--limit",
    String(MAX_FETCH),
    "--json",
    searchFields
  ]);
}

function searchOpenPrs() {
  const dateFlag = OPEN_FILTER === "created" ? "--created" : "--updated";

  return ghJson([
    "search",
    "prs",
    "--author",
    USER,
    "--state",
    "open",
    dateFlag,
    `>=${OPEN_SINCE}`,
    "--archived=false",
    "--sort",
    "updated",
    "--order",
    "desc",
    "--limit",
    String(MAX_FETCH),
    "--json",
    searchFields
  ]);
}

function enrichPrs(items, type) {
  return items.map((item, index) => {
    const repo = repoName(item.repository);
    const base = normalizePr(item, repo, type);

    let details = {};
    if (index < ENRICH_LIMIT) {
      details = ghJson(["pr", "view", item.url, "--json", prViewFields], {});
    }

    const labels = normalizeLabels(details.labels || item.labels || []);
    const language = repoLanguage(repo);
    const body = details.body || item.body || "";

    const enriched = {
      ...base,
      mergedAt: details.mergedAt || item.closedAt || null,
      changedFiles: numberOrNull(details.changedFiles),
      additions: numberOrNull(details.additions),
      deletions: numberOrNull(details.deletions),
      reviewDecision: details.reviewDecision || null,
      mergeStateStatus: details.mergeStateStatus || null,
      isDraft: Boolean(details.isDraft ?? item.isDraft ?? false),
      labels,
      language,
      summary: summarize(body || item.title || "")
    };

    enriched.stack = detectStack(enriched, body);
    return enriched;
  });
}

function normalizePr(item, repo, type) {
  return {
    type,
    repo,
    number: item.number,
    title: cleanText(item.title),
    url: item.url,
    state: item.state,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
    closedAt: item.closedAt || null,
    commentsCount: numberOrZero(item.commentsCount)
  };
}

const repoLangCache = new Map();

function repoLanguage(repo) {
  if (!repo) return "Other";
  if (repoLangCache.has(repo)) return repoLangCache.get(repo);

  let language = "Other";
  try {
    language = gh(["api", `repos/${repo}`, "--jq", ".language // \"Other\""]) || "Other";
  } catch {
    language = "Other";
  }

  repoLangCache.set(repo, language);
  return language;
}

function detectStack(pr, body = "") {
  const source = [
    pr.language,
    pr.repo,
    pr.title,
    pr.summary,
    body,
    ...(pr.labels || [])
  ]
    .join(" ")
    .toLowerCase();

  const found = new Set();
  const add = (name) => found.add(name);

  if (pr.language && pr.language !== "Other") {
    add(normalizeLanguage(pr.language));
  }

  const rules = [
    ["TypeScript", ["typescript", ".ts", ".tsx"]],
    ["JavaScript", ["javascript", ".js", ".jsx"]],
    ["React", ["react", "reactjs"]],
    ["Next.js", ["next.js", "nextjs"]],
    ["Node.js", ["node.js", "nodejs", "express"]],
    ["NestJS", ["nestjs", "nest.js"]],
    ["Java", [" java ", ".java"]],
    ["Spring", ["spring", "spring boot"]],
    ["Python", ["python", "django", "fastapi", "flask"]],
    ["Go", ["golang"]],
    ["MongoDB", ["mongodb", "mongo"]],
    ["PostgreSQL", ["postgresql", "postgres"]],
    ["MySQL", ["mysql"]],
    ["Redis", ["redis"]],
    ["Docker", ["docker", "container"]],
    ["AWS", ["aws", "lambda", "s3", "ec2"]],
    ["GCP", ["gcp", "google cloud"]],
    ["OpenAI", ["openai", "gpt"]],
    ["Gemini", ["gemini"]],
    ["WebSocket", ["websocket", "socket.io", "socketio"]],
    ["REST API", ["rest api", "api"]],
    ["OAuth", ["oauth"]],
    ["JWT", ["jwt"]]
  ];

  const padded = ` ${source} `;

  for (const [name, terms] of rules) {
    if (terms.some((term) => padded.includes(term))) add(name);
  }

  return [...found].filter(Boolean).slice(0, 5);
}

function normalizeLanguage(language) {
  const map = {
    JavaScript: "JavaScript",
    TypeScript: "TypeScript",
    Java: "Java",
    Python: "Python",
    Go: "Go",
    HTML: "HTML",
    CSS: "CSS",
    Shell: "Shell",
    Dockerfile: "Docker"
  };

  return map[language] || language;
}

function countTech(prs) {
  const counts = {};
  for (const pr of prs) {
    for (const tech of pr.stack || []) counts[tech] = (counts[tech] || 0) + 1;
  }
  return counts;
}

function buildReadmeSection(audit) {
  const { merged, open, summary, generatedAt, ranges } = audit;
  const topTech = summary.topTech.map((t) => t.name).slice(0, 10);

  const badges = [
    shield("merged", summary.mergedCount, "2ea44f"),
    shield("open", summary.openCount, "f0883e"),
    shield("repos", summary.reposTouched, "0969da"),
    shield("audit", "2y", "6f42c1"),
    shield("sync", dateOnly(generatedAt), "24292f")
  ].join("\n");

  const techStrip = buildTechStrip(topTech);
  const mergedList = markdownList(merged.slice(0, SHOW_MERGED), "merged");
  const openList = markdownList(open.slice(0, SHOW_OPEN), "open");

  const mergedMore =
    merged.length > SHOW_MERGED
      ? `\n- +${merged.length - SHOW_MERGED} more merged PRs in [full audit](./PR_AUDIT.md).`
      : "";

  const openMore =
    open.length > SHOW_OPEN
      ? `\n- +${open.length - SHOW_OPEN} more open PRs in [full audit](./PR_AUDIT.md).`
      : "";

  return `
<h3><b>PR Audit &amp; Open Work</b></h3>

<div align="center">

${badges}

${techStrip}

</div>

<sub>Auto-generated from PRs authored by <code>${escapeHtml(audit.user)}</code>. Merged PRs since <code>${ranges.mergedSince}</code>; open PRs ${ranges.openFilter} since <code>${ranges.openSince}</code>. Full log: <a href="./PR_AUDIT.md">PR_AUDIT.md</a> · Raw data: <a href="./data/pr-audit.json">data/pr-audit.json</a></sub>

<img src="https://img.shields.io/badge/Recently_Merged-Fixes-2ea44f?style=flat-square&logo=git-merge&logoColor=white" alt="Recently Merged Fixes" />

${mergedList || "_No merged PRs found in this range._"}${mergedMore}

<img src="https://img.shields.io/badge/Open_PRs-In_Progress-f0883e?style=flat-square&logo=github&logoColor=white" alt="Open PRs In Progress" />

${openList || "_No open PRs found in this range._"}${openMore}
`.trim();
}

function buildFullAudit(audit) {
  const { merged, open, summary, generatedAt, ranges } = audit;

  return `
# PR Audit

Generated: \`${generatedAt}\`  
Author: \`${audit.user}\`  
Merged PRs since: \`${ranges.mergedSince}\`  
Open PRs: \`${ranges.openFilter} >= ${ranges.openSince}\`

## Summary

| Metric | Count |
|---|---:|
| Merged PRs | ${summary.mergedCount} |
| Open PRs | ${summary.openCount} |
| Repositories touched | ${summary.reposTouched} |

## Top tech stack detected from PRs

${summary.topTech.length ? summary.topTech.map((t) => `- ${t.name}: ${t.count}`).join("\n") : "_No tech stack detected._"}

## Merged PRs

${tableFor(merged, "merged")}

## Open PRs

${tableFor(open, "open")}
`.trim();
}

function markdownList(items, type) {
  return items
    .map((p) => {
      const date = type === "merged" ? dateOnly(p.mergedAt || p.closedAt) : dateOnly(p.updatedAt);
      const status = type === "open" && p.isDraft ? " · draft" : "";
      const changes = p.changedFiles !== null ? ` · ${p.changedFiles} files` : "";
      const stack = p.stack?.length ? ` · ${p.stack.map((s) => `\`${s}\``).join(" ")}` : "";
      return `- [${escapeMd(p.repo)}#${p.number}: ${escapeMd(p.title)}](${p.url}) · ${date}${changes}${status}${stack}`;
    })
    .join("\n");
}

function tableFor(items, type) {
  if (!items.length) return "_No PRs found._";

  const rows = items.map((p) => {
    const date = type === "merged" ? dateOnly(p.mergedAt || p.closedAt) : dateOnly(p.updatedAt);
    const stack = p.stack?.length ? p.stack.join(", ") : "-";
    const changes =
      p.changedFiles !== null
        ? `${p.changedFiles} files, +${p.additions ?? "?"}/-${p.deletions ?? "?"}`
        : "-";

    return [
      `[${escapeTable(p.repo)}#${p.number}](${p.url})`,
      escapeTable(p.title),
      date,
      escapeTable(stack),
      changes
    ].join(" | ");
  });

  return ["| PR | Title | Date | Stack | Changes |", "|---|---|---|---|---|", ...rows].join("\n");
}

function updateReadme(section) {
  if (!existsSync(README_PATH)) throw new Error(`${README_PATH} not found.`);

  const readme = readFileSync(README_PATH, "utf8");
  const block = `${START}\n${section}\n${END}`;

  if (readme.includes(START) && readme.includes(END)) {
    const pattern = new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`);
    writeFileSync(README_PATH, readme.replace(pattern, block));
    return;
  }

  writeFileSync(README_PATH, `${readme.trim()}\n\n${block}\n`);
}

function shield(label, message, color) {
  const safeLabel = shieldPart(label);
  const safeMessage = shieldPart(message);
  return `<img src="https://img.shields.io/badge/${safeLabel}-${safeMessage}-${color}?style=for-the-badge" alt="${escapeHtml(label)}: ${escapeHtml(String(message))}" />`;
}

function shieldPart(value) {
  return encodeURIComponent(String(value).replace(/-/g, "--"));
}

function buildTechStrip(tech) {
  const iconMap = {
    Java: "java",
    JavaScript: "js",
    TypeScript: "ts",
    React: "react",
    "Next.js": "nextjs",
    Spring: "spring",
    NestJS: "nestjs",
    "Node.js": "nodejs",
    Python: "python",
    Go: "go",
    MongoDB: "mongodb",
    PostgreSQL: "postgres",
    MySQL: "mysql",
    Redis: "redis",
    AWS: "aws",
    GCP: "gcp",
    Docker: "docker"
  };

  const icons = tech.map((t) => iconMap[t]).filter(Boolean).slice(0, 10);
  if (!icons.length) return "";
  return `<img src="https://skillicons.dev/icons?i=${icons.join(",")}&perline=10" height="34" alt="Detected PR tech stack" />`;
}

function repoName(repo) {
  if (!repo) return "";
  if (typeof repo === "string") return repo;
  if (repo.nameWithOwner) return repo.nameWithOwner;
  if (repo.fullName) return repo.fullName;

  const owner =
    repo.owner?.login ||
    repo.owner?.name ||
    repo.owner ||
    repo.repositoryOwner?.login ||
    repo.repositoryOwner?.name;

  if (owner && repo.name) return `${owner}/${repo.name}`;
  return "";
}

function normalizeLabels(labels) {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name || ""))
    .filter(Boolean);
}

function summarize(text) {
  return cleanText(text).slice(0, 180);
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function dateOnly(value) {
  if (!value) return "-";
  return String(value).slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function sortMergedDesc(a, b) {
  return String(b.mergedAt || b.closedAt || b.updatedAt).localeCompare(String(a.mergedAt || a.closedAt || a.updatedAt));
}

function sortUpdatedDesc(a, b) {
  return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024
  }).trim();
}

function ghJson(args, fallback = []) {
  try {
    const output = gh(args);
    return output ? JSON.parse(output) : fallback;
  } catch (error) {
    console.error(`Failed: gh ${args.join(" ")}`);
    console.error(error.stderr?.toString?.() || error.message);
    return fallback;
  }
}

function escapeMd(value) {
  return String(value || "").replace(/([\[\]])/g, "\\$1");
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}