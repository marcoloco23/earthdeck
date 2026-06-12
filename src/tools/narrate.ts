import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { newId, nowIso } from "../util.js";

const MAX_NOTE_CHARS = 20_000; // mirrors the dashboard /ingest validator

/** Register narration tools: narrate (zero-key, dashboard-only). */
export function registerNarrateTools(server: McpServer): void {
  server.registerTool(
    "narrate",
    {
      title: "Dashboard narration (interpretation notes)",
      description:
        "Post a rich text note to the live dashboard — use it alongside the data tools to " +
        "interpret what the map and cards are showing: what the numbers mean, what to look " +
        "at next, caveats. Markdown-lite: '## ' headings, '- ' bullets, **bold**, blank-line " +
        "paragraphs. To STREAM a growing narrative, call again with the same noteId and the " +
        "full updated text — the dashboard updates that one card in place instead of adding " +
        "another. Optional bbox anchors the note to the map. Zero keys; if no dashboard is " +
        "running this is a harmless no-op.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Short headline for the note card."),
        text: z
          .string()
          .min(1)
          .max(MAX_NOTE_CHARS)
          .describe("Note body (markdown-lite). For updates, send the FULL text, not a delta."),
        kind: z
          .enum(["info", "insight", "warning"])
          .optional()
          .describe("Accent: info (default), insight (key finding), warning (caveat/risk)."),
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .optional()
          .describe("Optional bounding box [west, south, east, north] to anchor the note on the map."),
        noteId: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,128}$/)
          .optional()
          .describe("Pass the noteId returned by an earlier call to UPDATE that note in place."),
      },
    },
    async ({ title, text, kind, bbox, noteId }) =>
      safe(async () => {
        const id = noteId ?? newId();
        const pushed = await pushCard({
          id,
          type: "note",
          ts: nowIso(),
          title,
          ...(bbox ? { bbox: bbox as BBox } : {}),
          payload: { text, kind: kind ?? "info" },
        });
        return {
          noteId: id,
          dashboard: pushed ? "pushed" : "dashboard offline",
          hint: "Call narrate again with this noteId and the full updated text to stream.",
        };
      }),
  );
}
