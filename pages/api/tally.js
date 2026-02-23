// pages/api/tally.js
// Vercel (Node.js) webhook endpoint for Tally -> Supabase
// - Stores RAW payload first into `tally_intake`
// - Parses fields safely
// - Creates `estimate_jobs` (with retries)
// - Returns non-200 on failures so Tally shows errors/retries
// - Logs and returns env info so you know if Tally is hitting prod vs preview
//
// Required Vercel env vars (set for the correct environment: Production/Preview):
//   SUPABASE_URL = https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = <service role key>
// Recommended:
//   NODE_OPTIONS = --dns-result-order=ipv4first

export const config = { runtime: "nodejs" };

import dns from "dns";
import { createClient } from "@supabase/supabase-js";

// Force IPv4-first DNS resolution to avoid intermittent TLS ECONNRESET to Supabase
dns.setDefaultResultOrder("ipv4first");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid SUPABASE_URL)";
  }
}

function firstUploadedFile(value) {
  if (!value) return null;                 // null/undefined
  if (Array.isArray(value)) return value[0] ?? null; // [file,...]
  if (typeof value === "object") return value;       // single object
  return null;
}

function getFieldByLabel(fields, label) {
  const target = (label || "").toLowerCase();
  return fields.find((f) => (f?.label || "").toLowerCase() === target) || null;
}

async function insertEstimateJobWithRetry(supabase, row, attempts = 3) {
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    console.log(`estimate_jobs insert attempt ${i}/${attempts}`);

    const { data, error } = await supabase
      .from("estimate_jobs")
      .insert(row)
      .select("id")
      .single();

    if (!error) return { data, error: null };

    lastErr = error;
    console.error("estimate_jobs insert error:", error);

    if (i < attempts) {
      const backoff = i === 1 ? 250 : i === 2 ? 750 : 1500;
      await sleep(backoff);
    }
  }

  return { data: null, error: lastErr };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const envInfo = {
    vercelEnv: process.env.VERCEL_ENV, // "production" | "preview" | "development"
    vercelUrl: process.env.VERCEL_URL, // hostname of the deployment handling this request
  };

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing env vars:", {
      hasSUPABASE_URL: !!supabaseUrl,
      hasSUPABASE_SERVICE_ROLE_KEY: !!supabaseKey,
      ...envInfo,
    });
    return res.status(500).json({
      ok: false,
      error: "Missing server env vars",
      ...envInfo,
      version: "tally-intake-v2",
    });
  }

  const body = req.body; // Next.js pages/api parses JSON automatically when sent as JSON

  const eventId = body?.eventId ?? null;
  const submissionId = body?.data?.submissionId ?? body?.data?.responseId ?? null;
  const eventType = body?.eventType ?? null;

  console.log("HIT_TALLY_WEBHOOK", {
    eventId,
    submissionId,
    eventType,
    supabaseHost: safeHost(supabaseUrl),
    ...envInfo,
  });

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  // --- Optional connectivity ping (helps diagnose TLS/DNS issues) ---
  try {
    const ping = await fetch(`${supabaseUrl}/rest/v1/`, { method: "GET" });
    console.log("SUPABASE_PING_STATUS", ping.status);
  } catch (e) {
    console.error("SUPABASE_PING_FAILED", String(e?.message || e));
    // Keep going; insert will fail too, but logs will show why.
  }

  // 0) Store RAW intake FIRST
  const { data: intakeRow, error: intakeError } = await supabase
    .from("tally_intake")
    .insert({
      event_id: eventId,
      submission_id: submissionId,
      payload: body,
      parse_status: "received",
      parse_error: null,
    })
    .select("id")
    .single();

  console.log("tally_intake insert:", { intakeId: intakeRow?.id ?? null, intakeError });

  if (intakeError) {
    return res.status(502).json({
      ok: false,
      error: "Failed to store webhook intake",
      details: intakeError?.message || String(intakeError),
      ...envInfo,
      version: "tally-intake-v2",
    });
  }

  const updateIntake = async (patch) => {
    try {
      await supabase.from("tally_intake").update(patch).eq("id", intakeRow.id);
    } catch (e) {
      console.error("Failed to update tally_intake:", e);
    }
  };

  try {
    // 1) Parse fields
    const fields = body?.data?.fields || [];

    const email = getFieldByLabel(fields, "Email")?.value || "";
    const firstName = getFieldByLabel(fields, "First Name")?.value || "";
    const lastName = getFieldByLabel(fields, "Last Name")?.value || "";
    const phone = getFieldByLabel(fields, "Phone")?.value || "";
    const notes = getFieldByLabel(fields, "Additional Information")?.value || "";

    const binsrFile = firstUploadedFile(getFieldByLabel(fields, "BINSR")?.value);
    const inspFile = firstUploadedFile(getFieldByLabel(fields, "Inspection Report")?.value);

    const binsrUrl = binsrFile?.url ?? null;
    const inspectionUrl = inspFile?.url ?? null;

    console.log("Parsed Tally fields:", {
      email: !!email,
      name: `${firstName} ${lastName}`.trim(),
      hasBinsr: !!binsrUrl,
      hasInspection: !!inspectionUrl,
    });

    // 2) Validation (adjust to your business rules)
    if (!binsrUrl && !inspectionUrl) {
      await updateIntake({
        parse_status: "parse_failed",
        parse_error: "No files uploaded (BINSR or Inspection Report required).",
      });
      return res.status(400).json({
        ok: false,
        error: "No files uploaded (BINSR or Inspection Report required).",
        ...envInfo,
        version: "tally-intake-v2",
      });
    }

    await updateIntake({ parse_status: "parsed", parse_error: null });

    // 3) Create the estimate job
    const jobRow = {
      status: "queued",
      email,
      name: `${firstName} ${lastName}`.trim(),
      phone,
      notes,
      binsr_url: binsrUrl,
      inspection_url: inspectionUrl,

      // If you add these columns to estimate_jobs, uncomment:
      // intake_id: intakeRow.id,
      // event_id: eventId,
      // submission_id: submissionId,
    };

    const { data: jobData, error: jobError } = await insertEstimateJobWithRetry(
      supabase,
      jobRow,
      3
    );

    console.log("estimate_jobs insert result:", { jobId: jobData?.id ?? null, jobError });

    if (jobError) {
      await updateIntake({
        parse_status: "job_insert_failed",
        parse_error: jobError?.message || String(jobError),
      });

      return res.status(502).json({
        ok: false,
        error: "Failed to create estimate job",
        details: jobError?.message || String(jobError),
        ...envInfo,
        version: "tally-intake-v2",
      });
    }

    return res.status(200).json({
      ok: true,
      intakeId: intakeRow?.id ?? null,
      jobId: jobData?.id ?? null,
      submissionId,
      ...envInfo,
      version: "tally-intake-v2",
    });
  } catch (e) {
    console.error("tally handler fatal error:", e);

    await updateIntake({
      parse_status: "server_error",
      parse_error: String(e?.message || e),
    });

    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: String(e?.message || e),
      ...envInfo,
      version: "tally-intake-v2",
    });
  }
}
