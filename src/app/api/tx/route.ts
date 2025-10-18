import { NextResponse } from "next/server";
import { redis } from "@/lib/redis"; // pokud alias '@/...' nemáš, použij relativní cestu: ../../../lib/redis

type Tx = { id: string; amount: number; ts: number };
const KEY = "finance:tx"; // jedna sdílená „peněženka“

export async function GET() {
  const data = (await redis.get<Tx[] | null>(KEY)) ?? [];
  return NextResponse.json({ tx: Array.isArray(data) ? data : [] }, { status: 200 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.tx)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const cleaned: Tx[] = body.tx.filter(
    (t: any) => typeof t?.id === "string" && Number.isFinite(t?.amount) && Number.isFinite(t?.ts)
  );
  await redis.set(KEY, cleaned);
  return NextResponse.json({ ok: true }, { status: 200 });
}
