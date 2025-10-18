// src/app/api/tx/route.ts
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis"; // pokud alias "@/..." nemáš, použij relativní: ../../../lib/redis

export type Tx = { id: string; amount: number; ts: number };
const KEY = "finance:tx";

// type guard – ověříme payload bezpečně
function isTx(x: unknown): x is Tx {
  const t = x as Partial<Tx>;
  return typeof t?.id === "string" && Number.isFinite(t?.amount) && Number.isFinite(t?.ts);
}

export async function GET() {
  const data = (await redis.get<Tx[] | null>(KEY)) ?? [];
  const tx = Array.isArray(data) ? data.filter(isTx) : [];
  return NextResponse.json({ tx }, { status: 200 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as unknown;
  if (!body || typeof body !== "object" || !Array.isArray((body as { tx?: unknown }).tx)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const incoming = (body as { tx: unknown[] }).tx;
  const cleaned: Tx[] = incoming.filter(isTx);

  await redis.set(KEY, cleaned);
  return NextResponse.json({ ok: true }, { status: 200 });
}
