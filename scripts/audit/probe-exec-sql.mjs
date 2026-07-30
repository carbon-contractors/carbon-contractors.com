/**
 * probe-exec-sql.mjs — READ-ONLY reconnaissance for CC-054.
 *
 * Determines whether an `exec_sql` RPC exists on the Supabase project and, if so,
 * whether the public `anon` role can execute it. Executes no DDL and no writes.
 *
 * Run from the repo root so it can resolve node_modules and .env.local:
 *   node --env-file=.env.local <path-to-this-file>
 */

const URL_ = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !ANON || !SVC) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// Candidate parameter names — we don't know the signature it was created with.
const PARAM_NAMES = ["sql", "query", "q", "statement", "sql_query", "command"];
const PROBE = "select 1 as ok";

/** Call an RPC by name with a given single-parameter payload. */
async function rpc(key, fn, payload) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let body;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const short = (b) =>
  typeof b === "string"
    ? b.slice(0, 200)
    : JSON.stringify(b).slice(0, 300);

console.log("=".repeat(70));
console.log("CC-054 — exec_sql reconnaissance (read-only)");
console.log("=".repeat(70));

// ── Step 1: does exec_sql exist, and under what parameter name? ──────────────
console.log("\n[1] Probing for exec_sql with the SERVICE ROLE key\n");

let signature = null;
for (const p of PARAM_NAMES) {
  const r = await rpc(SVC, "exec_sql", { [p]: PROBE });
  const hint =
    r.status === 404 ? "not found with this signature" : r.status === 200 ? "EXECUTED" : "";
  console.log(`    exec_sql(${p}) -> ${r.status} ${hint}`);
  if (r.status !== 404) console.log(`        ${short(r.body)}`);
  if (r.status === 200) {
    signature = p;
    break;
  }
}

if (!signature) {
  console.log(
    "\n    No exec_sql reachable via PostgREST under any tried parameter name.\n" +
      "    Either it does not exist, it is not in an exposed schema, or the\n" +
      "    signature differs. Verify directly in the Supabase SQL editor with:\n" +
      "        select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner,\n" +
      "               pg_get_function_identity_arguments(p.oid) as args, p.proacl\n" +
      "        from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n" +
      "        where p.proname ilike '%exec%sql%';",
  );
} else {
  console.log(`\n    FOUND: exec_sql(${signature}) executes with the service role.`);

  // ── Step 2: introspect it, using itself ───────────────────────────────────
  console.log("\n[2] Introspecting the function via itself\n");
  const introspect = `
    select json_agg(row_to_json(t)) from (
      select n.nspname                                    as schema,
             p.proname                                    as name,
             pg_get_function_identity_arguments(p.oid)     as args,
             p.prosecdef                                  as security_definer,
             pg_get_userbyid(p.proowner)                   as owner,
             coalesce(array_to_string(p.proacl, ' | '), 'DEFAULT (inherits schema/PUBLIC)') as acl
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'exec_sql'
    ) t`;
  const meta = await rpc(SVC, "exec_sql", { [signature]: introspect });
  console.log(`    ${short(meta.body)}`);

  console.log("\n[3] Explicit EXECUTE grants per role\n");
  const grants = `
    select json_agg(row_to_json(t)) from (
      select grantee, privilege_type
      from information_schema.role_routine_grants
      where routine_name = 'exec_sql'
    ) t`;
  const g = await rpc(SVC, "exec_sql", { [signature]: grants });
  console.log(`    ${short(g.body)}`);
}

// ── Step 4: the decisive test — can the PUBLIC anon key run it? ─────────────
console.log("\n[4] DECISIVE TEST — attempting exec_sql with the PUBLIC anon key\n");

let anonCanExecute = false;
for (const p of signature ? [signature] : PARAM_NAMES) {
  const r = await rpc(ANON, "exec_sql", { [p]: PROBE });
  console.log(`    anon exec_sql(${p}) -> ${r.status}`);
  console.log(`        ${short(r.body)}`);
  if (r.status === 200) anonCanExecute = true;
}

// ── Step 5: generalise — any OTHER routine the anon role can execute? ───────
// exec_sql is the one we know about. The real question is whether anything else
// was created out of band with the same problem.
if (signature) {
  console.log("\n[5] All public-schema routines and their EXECUTE grants\n");
  const all = `
    select json_agg(row_to_json(t)) from (
      select r.routine_name                as name,
             r.security_type               as security,
             coalesce(string_agg(distinct g.grantee, ', '), '(none explicit)') as granted_to
      from information_schema.routines r
      left join information_schema.role_routine_grants g
             on g.routine_name = r.routine_name
            and g.privilege_type = 'EXECUTE'
      where r.specific_schema = 'public'
      group by r.routine_name, r.security_type
      order by r.routine_name
    ) t`;
  const a = await rpc(SVC, "exec_sql", { [signature]: all });
  console.log(`    ${short(a.body)}`);
  console.log(
    "\n    Cross-check this list against supabase/migrations/*.sql. Anything here\n" +
      "    that is not in a migration was created out of band and is untracked.\n" +
      "    Pay particular attention to any row where granted_to includes anon.",
  );
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(70));
if (anonCanExecute) {
  console.log("VERDICT: CRITICAL — the anon key can execute arbitrary SQL.");
  console.log("The anon key ships to every browser. This bypasses every RLS policy");
  console.log("in migrations 003, 005, 010 and 011, and exposes the waitlist emails.");
  console.log("Revoke now, then rotate the anon and service role keys.");
} else if (signature) {
  console.log("VERDICT: exec_sql EXISTS but the anon key cannot execute it.");
  console.log("Not a live exposure. Still restrict to service_role explicitly and");
  console.log("record it in a migration so it stops being invisible.");
} else {
  console.log("VERDICT: no exec_sql reachable. Confirm in the SQL editor before");
  console.log("closing CC-054 — absence via PostgREST is not proof of absence.");
}
console.log("=".repeat(70));
