/**
 * check-issue-ids.mjs — refuse two open PRs claiming the same CC-### id.
 *
 * ## The gap this fills, and the one it does not
 *
 * Git already catches a branch that adds `CC-096.md` when master has one: that is an
 * add/add conflict and GitHub marks the PR conflicting. What nothing catches is **two
 * open PRs each adding the same id while neither has merged.** Both look clean; the
 * loser finds out during conflict resolution, by which point the id is threaded through
 * commit messages, cross-references and often a branch name.
 *
 * That happened three times on 2026-08-16 — CC-092, then CC-096 twice — and each
 * renumber touched 20+ references across a dozen files. `backlog.mjs` cannot see it:
 * it validates one working tree, and the collision exists only across branches.
 *
 * Complements the filename-vs-frontmatter assertion in `backlog.mjs`, which catches the
 * *other* half — a renumber that changed one and not the other.
 *
 * ## Behaviour
 *
 * Reads every open PR's added issue files through the API and fails if any id is
 * claimed twice. Symmetric on purpose: both PRs go red, because which one should move
 * is a judgement call (first claim usually wins) and not one a script should make.
 *
 * Skips rather than fails when it cannot see the API — a fork PR gets no token, and a
 * check that hard-fails on forks is a check people disable.
 */

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

const ISSUE_FILE = /^docs\/backlog\/(CC-\d+)\.md$/;

function skip(why) {
  console.log(`SKIP — ${why}`);
  process.exit(0);
}

if (!repo) skip("GITHUB_REPOSITORY is not set; this check only runs in Actions");
if (!token) skip("no GITHUB_TOKEN (expected on fork pull requests)");

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const openPrs = await api(`/repos/${repo}/pulls?state=open&per_page=100`);

if (openPrs.length === 0) skip("no open pull requests");

/** id -> [{ number, title }] */
const claims = new Map();

for (const pr of openPrs) {
  // `added` only. A PR that merely edits an existing issue is not claiming the id.
  const files = await api(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`);
  for (const f of files) {
    if (f.status !== "added") continue;
    const m = f.filename.match(ISSUE_FILE);
    if (!m) continue;
    const id = m[1];
    if (!claims.has(id)) claims.set(id, []);
    claims.get(id).push({ number: pr.number, title: pr.title });
  }
}

const collisions = [...claims.entries()].filter(([, prs]) => prs.length > 1);

if (collisions.length === 0) {
  const claimed = [...claims.keys()].sort();
  console.log(
    claimed.length
      ? `OK - ${claimed.length} issue id(s) claimed across ${openPrs.length} open PR(s), no duplicates: ${claimed.join(", ")}`
      : `OK - no open PR adds a backlog issue (${openPrs.length} open)`,
  );
  process.exit(0);
}

console.error("\nDuplicate backlog issue ids across open pull requests:\n");
for (const [id, prs] of collisions) {
  console.error(`  ${id} is claimed by:`);
  for (const p of prs) console.error(`    #${p.number}  ${p.title}`);
}
console.error(
  "\nOne of them has to move. First claim usually wins - compare the commit dates that\n" +
    "added each file. Renumbering means the filename, the frontmatter id, the heading, and\n" +
    "every reference to it: `git grep -n CC-0XX` before you push.\n",
);
process.exit(1);
