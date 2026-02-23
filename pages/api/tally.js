import crypto from "crypto";

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const rawBody = await readRawBody(req);

  // Tally signature header name can vary; check both
  const sig =
    req.headers["tally-signature"] ||
    req.headers["x-tally-signature"] ||
    req.headers["x-webhook-signature"];

  const secret = process.env.TALLY_SIGNING_SECRET;

  if (!secret) {
    console.log("Missing TALLY_SIGNING_SECRET env var");
    return res.status(500).json({ ok: false });
  }

  if (!sig) {
    console.log("No signature header found. Headers:", Object.keys(req.headers));
    // If Tally truly doesn't sign, see fallback below.
    return res.status(401).send("Missing signature");
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  if (sig !== expected) {
    console.log("Signature mismatch", { sig, expected });
    return res.status(401).send("Invalid signature");
  }

  // Now safely parse JSON
  const payload = JSON.parse(rawBody.toString("utf8"));
  console.log("Verified Tally payload received");

  return res.status(200).json({ ok: true });
}
