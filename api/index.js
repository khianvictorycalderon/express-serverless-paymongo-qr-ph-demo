require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));
app.use(express.static(path.join(process.cwd(), "public")));
app.use(express.urlencoded({ extended: false }));
// keep the raw body: PayMongo's signature is computed over the exact bytes it sent
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));

const MIN_AMOUNT = Number(process.env.MIN_AMOUNT || 20); // PHP

// ---------- PostgreSQL ----------
const databaseUrl = process.env.DATABASE_URL || process.env.DB_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set to a PostgreSQL connection string.");
const db = new Pool({ connectionString: databaseUrl, max: 5 });

let ready;
const init = () =>
  (ready ??= db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id         SERIAL PRIMARY KEY,
      intent_id  TEXT UNIQUE NOT NULL,
      amount     INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      qr_image   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at    TIMESTAMPTZ
    )`));

// ---------- PayMongo ----------
async function paymongo(method, endpoint, attributes) {
  const res = await fetch("https://api.paymongo.com/v1" + endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(process.env.PAYMONGO_SECRET_KEY + ":").toString("base64"),
    },
    body: JSON.stringify({ data: { attributes } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.errors?.map((e) => e.detail).join("; ") || `PayMongo error (${res.status})`);
  }
  return json.data;
}

// ---------- View helpers ----------
app.locals.peso = (centavos) =>
  "₱" + (centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
app.locals.when = (s) =>
  s
    ? new Date(s).toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

async function renderHome(res, { error, amount, status = 200, txId } = {}) {
  await init();
  const { rows } = await db.query(
    "SELECT id, intent_id, amount, status, created_at, paid_at FROM transactions ORDER BY id DESC LIMIT 100"
  );
  let qr = null;
  if (txId) {
    const r = await db.query(
      "SELECT id, amount, qr_image FROM transactions WHERE id = $1 AND status = 'pending'",
      [txId]
    );
    qr = r.rows[0] || null;
  }
  res.status(status).render("index", { rows, qr, error, amount, minAmount: MIN_AMOUNT });
}

// ---------- Routes ----------
app.get("/", (req, res, next) => renderHome(res, { txId: Number(req.query.tx) || null }).catch(next));

app.post("/pay", async (req, res, next) => {
  const amount = Number(req.body.amount);
  try {
    if (!Number.isFinite(amount) || amount < MIN_AMOUNT) {
      return await renderHome(res, { error: `Minimum amount is ₱${MIN_AMOUNT}.`, amount: req.body.amount, status: 400 });
    }
    const centavos = Math.round(amount * 100);

    const intent = await paymongo("POST", "/payment_intents", {
      amount: centavos,
      currency: "PHP",
      payment_method_allowed: ["qrph"],
      description: "QR Ph demo payment",
    });
    const method = await paymongo("POST", "/payment_methods", {
      type: "qrph",
      billing: { name: "Demo Payer", email: "demo@example.com" },
    });
    const attached = await paymongo("POST", `/payment_intents/${intent.id}/attach`, {
      payment_method: method.id,
      client_key: intent.attributes.client_key,
    });
    const qrImage = attached.attributes.next_action?.code?.image_url;
    if (!qrImage) throw new Error("PayMongo did not return a QR code.");

    await init();
    const ins = await db.query(
      "INSERT INTO transactions (intent_id, amount, qr_image) VALUES ($1, $2, $3) RETURNING id",
      [intent.id, centavos, qrImage]
    );
    res.redirect(`/?tx=${ins.rows[0].id}`);
  } catch (err) {
    console.error(err);
    renderHome(res, { error: err.message, amount: req.body.amount, status: 502 }).catch(next);
  }
});

// PayMongo calls this. Register it as: https://YOUR-DOMAIN/webhook
// Requests are authenticated with the webhook signing secret (WEBHOOK_SECRET, starts with whsk_).
function validSignature(req) {
  const secret = process.env.WEBHOOK_SECRET;
  const header = req.get("Paymongo-Signature");
  if (!secret || !header || req.rawBody === undefined) return false;

  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=")));
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${req.rawBody}`).digest("hex");
  const livemode = req.body?.data?.attributes?.livemode;
  const given = (livemode ? parts.li : parts.te) || "";

  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

app.post("/webhook", async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  try {
    await init();
    const event = req.body?.data?.attributes;
    const type = event?.type;
    const intentId =
      event?.data?.attributes?.payment_intent_id || JSON.stringify(req.body).match(/pi_[A-Za-z0-9]+/)?.[0];

    if (intentId) {
      if (type === "payment.paid") {
        await db.query(
          "UPDATE transactions SET status = 'paid', paid_at = NOW(), qr_image = NULL WHERE intent_id = $1 AND status != 'paid'",
          [intentId]
        );
      } else if (type === "payment.failed" || type === "qrph.expired") {
        await db.query(
          "UPDATE transactions SET status = $1 WHERE intent_id = $2 AND status = 'pending'",
          [type === "qrph.expired" ? "expired" : "failed", intentId]
        );
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Something went wrong.");
});

module.exports = app;

// Local dev: `npm run dev` (on Vercel/Netlify the app is imported, not listened)
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`http://localhost:${port}`));
}
