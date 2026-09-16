import { NextResponse } from "next/server";
import { userHome } from "@/lib/user-home";

export async function GET() {
  return NextResponse.json({ home: userHome() });
}
