import QRCode from "qrcode";
import { NextResponse } from "next/server";
import { ensureWacliSync, getWacliAuthStatus } from "@/lib/wacli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let status = await getWacliAuthStatus();
  if (status.authenticated) {
    await ensureWacliSync(new URL(request.url).origin);
    status = await getWacliAuthStatus();
  }
  const qrDataUrl = status.qr
    ? await QRCode.toDataURL(status.qr, { width: 340, margin: 2, errorCorrectionLevel: "M" })
    : null;
  return NextResponse.json({ ...status, qrDataUrl }, { headers: { "Cache-Control": "no-store" } });
}
