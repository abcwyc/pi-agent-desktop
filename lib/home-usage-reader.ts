import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { projectHomeUsage, summarizeHomeUsage, type HomeUsageRange, type HomeUsageRecord } from "./home-usage.ts";

/** Paths must come from the server's session catalogue, never from request input. */
export async function readHomeUsage(sessions: { path: string; created: string }[], range: HomeUsageRange, now = new Date()) {
  const records: HomeUsageRecord[] = [];
  let skippedFiles = 0;
  for (const session of sessions) {
    const stream = createReadStream(session.path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        try {
          const record = projectHomeUsage(JSON.parse(line), session.path + ":" + lineNumber);
          if (record) records.push(record);
        } catch {
          // An append-in-progress or malformed line must not hide other sessions.
        }
      }
    } catch {
      skippedFiles++;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return { ...summarizeHomeUsage(records, sessions.map((s) => s.created), range, now), skippedFiles };
}
