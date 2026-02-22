export default function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  console.log("Tally payload:", JSON.stringify(req.body));
  return res.status(200).json({ ok: true });
}
