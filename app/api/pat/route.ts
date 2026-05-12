import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { adminClient, hashToken } from "@/src/lib/supabase/admin";

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// GET  /api/pat — does a token exist for this user?
// POST /api/pat — rotate (or create) token; returns plaintext once
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data } = await adminClient()
    .from("pat_tokens")
    .select("created_at")
    .eq("clerk_id", userId)
    .maybeSingle();

  return NextResponse.json({ exists: !!data, created_at: data?.created_at ?? null });
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Ensure profile exists before inserting token (FK constraint)
  await adminClient()
    .from("profiles")
    .upsert({ clerk_id: userId }, { onConflict: "clerk_id" });

  const token = generateToken();
  const hash = await hashToken(token);

  const { error } = await adminClient()
    .from("pat_tokens")
    .upsert(
      { clerk_id: userId, token_hash: hash, created_at: new Date().toISOString() },
      { onConflict: "clerk_id" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Plaintext returned once — never stored.
  return NextResponse.json({ token });
}
