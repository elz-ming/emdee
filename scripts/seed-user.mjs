// One-off: copy every file under public/ into <userId>/ in Supabase Storage.
// Usage:  node scripts/seed-user.mjs <userId>
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const userId = process.argv[2];
if (!userId) { console.error("Usage: node scripts/seed-user.mjs <userId>"); process.exit(1); }

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const bucket = sb.storage.from("vaults");

async function walk(folder) {
  const { data } = await bucket.list(folder, { limit: 1000 });
  if (!data) return [];
  const out = [];
  for (const item of data) {
    const itemPath = `${folder}/${item.name}`;
    if (item.id === null) out.push(...(await walk(itemPath)));
    else if (item.name.endsWith(".md")) out.push(itemPath);
  }
  return out;
}

const sources = await walk("public");
console.log(`Copying ${sources.length} files from public/ → ${userId}/`);
for (const src of sources) {
  const { data, error } = await bucket.download(src);
  if (error || !data) { console.error(`  ✗ read ${src}: ${error?.message}`); continue; }
  const content = await data.text();
  const dest = `${userId}/${src.slice("public/".length)}`;
  const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
  const { error: upErr } = await bucket.upload(dest, blob, { upsert: true, contentType: "text/markdown; charset=utf-8" });
  if (upErr) console.error(`  ✗ write ${dest}: ${upErr.message}`);
  else console.log(`  ✓ ${dest}`);
}
console.log("Done.");
