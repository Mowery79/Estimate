// pages/api/tally.js
// Runs on Node.js (Vercel serverless). Do NOT ack 200 until we've stored the webhook.
// This version:
// 1) Stores raw Tally payload into tally_intake (always)
// 2) Parses fields safely (including FILE_UPLOAD null/object/array)
// 3) Inserts estimate_jobs with retry/backoff
// 4) Updates tally_intake parse_status/parse_error accordingly
// 5) Returns non-200 on failures so Tally can show errors / retry

export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid SUPABASE_URL)";
  }
}

// Normalize FILE_UPLOAD value into a single file object or null
function firstUploadedFile(value) {
  if (!value) return null; // null/undefined/empty
  if (Array.isArray(value)) return value[0] ?? null; // [file,...]
  if (typeof value === "object") return value; // single file object
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

    // Exponential-ish backoff
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

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing env vars:", {
      hasSUPABASE_URL: !!supabaseUrl,
      hasSUPABASE_SERVICE_ROLE_KEY: !!supabaseKey,
    });
    return res.status(500).json({ ok: false, error: "Missing server env vars" });
  }

  // Tally sends JSON. In Next.js pages/api, req.body is already parsed if content-type is JSON.
  const body = req.body;

  const eventId = body?.eventId ?? null;
  const submissionId = body?.data?.submissionId ?? body?.data?.responseId ?? null;
  const eventType = body?.eventType ?? null;

  console.log("HIT_TALLY_WEBHOOK", {
    eventId,
    submissionId,
    eventType,
    supabaseHost: safeHost(supabaseUrl),
  });

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  // 0) Store RAW intake first (so we never lose payload even if parsing fails)
  const { data: intakeRow, error: intakeError } = await supabase
    .from("tally_intake")
    .insert({
      event_id: eventId,
      submission_id: submissionId,
      payload: body,
      parse_status: "received",
    })
    .select("id")
    .single();

  console.log("tally_intake insert:", { intakeId: intakeRow?.id ?? null, intakeError });

  if (intakeError) {
    // Return non-200 so Tally shows failure/retry (instead of silently "Delivered")
    return res.status(502).json({
      ok: false,
      error: "Failed to store webhook intake",
      details: intakeError?.message || String(intakeError),
      version: "tally-intake-v1",
    });
  }

  // Helper to update intake status
  const updateIntake = async (patch) => {
    try {
      await supabase.from("tally_intake").update(patch).eq("id", intakeRow.id);
    } catch (e) {
      console.error("Failed to update tally_intake status:", e);
    }
  };

  try {
    // 1) Parse fields safely
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

    // 2) Validation rule (edit as desired)
    // If you require at least one file:
    if (!binsrUrl && !inspectionUrl) {
      await updateIntake({
        parse_status: "parse_failed",
        parse_error: "No files uploaded (BINSR or Inspection Report required).",
      });
      return res.status(400).json({
        ok: false,
        error: "No files uploaded (BINSR or Inspection Report required).",
        version: "tally-intake-v1",
      });
    }

    // 3) Mark intake parsed OK
    await updateIntake({
      parse_status: "parsed",
      parse_error: null,
    });

    // 4) Insert estimate job (with retry)
    const jobRow = {
      status: "queued",
      email,
      name: `${firstName} ${lastName}`.trim(),
      phone,
      notes,
      binsr_url: binsrUrl,
      inspection_url: inspectionUrl,

      // If your estimate_jobs table has these columns, uncomment:
      // intake_id: intakeRow.id,
      // event_id: eventId,
      // submission_id: submissionId,
    };

    const { data: jobData, error: jobError } = await insertEstimateJobWithRetry(
      supabase,
      jobRow,
      3
    );

    console.log("estimate_jobs insert result:", { jobData, jobError });

    if (jobError) {
      await updateIntake({
        parse_status: "job_insert_failed",
        parse_error: jobError?.message || String(jobError),
      });

      return res.status(502).json({
        ok: false,
        error: "Failed to create estimate job",
        details: jobError?.message || String(jobError),
        version: "tally-intake-v1",
      });
    }

    // 5) Success
    return res.status(200).json({
      ok: true,
      jobId: jobData?.id ?? null,
      intakeId: intakeRow?.id ?? null,
      submissionId,
      version: "tally-intake-v1",
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
      version: "tally-intake-v1",
    });
  }
}
