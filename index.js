// index.js (or api/index.js if you keep your server in /api)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const app = express();

/* ----------------------------- Basic Config ----------------------------- */
const {
  PORT = 3000,
  NODE_ENV = "development",
  MONGODB_URI,
  STRIPE_SECRET_KEY,
  JWT_SECRET,
} = process.env;

if (!MONGODB_URI) throw new Error("❌ MONGODB_URI missing in environment");
if (!STRIPE_SECRET_KEY) throw new Error("❌ STRIPE_SECRET_KEY missing in environment");
if (!JWT_SECRET) throw new Error("❌ JWT_SECRET missing in environment");

const stripe = Stripe(STRIPE_SECRET_KEY);
const isProd = NODE_ENV === "production";

/* ------------------------------ Middleware ------------------------------ */
app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.json({ limit: "200kb" }));

const ALLOWED_ORIGINS = [
  "https://towertrack-ph-assestwelve.netlify.app",
  "http://localhost:5173",
  // add your deployed frontend domain here:
  // "https://your-frontend.vercel.app",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
  })
);

/* ------------------------- MongoDB (serverless-safe) ------------------------- */
// Cache the client/promise across serverless invocations
let cached = globalThis.__towertrack_mongo__;
if (!cached) {
  cached = globalThis.__towertrack_mongo__ = { client: null, promise: null };
}

async function getMongoClient() {
  if (cached.client) return cached.client;
  if (!cached.promise) {
    const client = new MongoClient(MONGODB_URI, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    });
    cached.promise = client.connect().then((c) => c);
  }
  cached.client = await cached.promise;
  return cached.client;
}

let db, apartmentsCollection, agreementsCollection, usersCollection;

async function connectDB() {
  const client = await getMongoClient();
  db = client.db("towerTrackDB");
  apartmentsCollection = db.collection("apartments");
  agreementsCollection = db.collection("agreements");
  usersCollection = db.collection("users");

  await Promise.allSettled([
    agreementsCollection.createIndex({ userEmail: 1 }, { unique: true }),
    usersCollection.createIndex({ email: 1 }, { unique: true }),
    db.collection("coupons").createIndex({ code: 1 }, { unique: true }),
    db.collection("payments").createIndex({ email: 1, createdAt: -1 }),
    db.collection("announcements").createIndex({ createdAt: -1 }),
    db.collection("buildings").createIndex({ createdAt: -1 }),
  ]);
}

// Ensure DB is ready per request (cheap if already connected)
async function ensureDB(req, res, next) {
  try {
    if (!db) await connectDB();
    return next();
  } catch (e) {
    console.error("DB connection error:", e);
    return res.status(500).json({ error: "Database connection failed" });
  }
}
app.use(ensureDB);

/* ------------------------- Small Utils / Helpers ------------------------ */
const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? "none" : "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const sendError = (res, code, message, extra = {}) =>
  res.status(code).json({ error: message, ...extra });

const generateToken = (email) => jwt.sign({ email }, JWT_SECRET, { expiresIn: "7d" });

const isValidObjectId = (id) => {
  try {
    return !!new ObjectId(id);
  } catch {
    return false;
  }
};

/* ----------------------------- Auth Middlewares ----------------------------- */
const verifyJWT = (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return sendError(res, 401, "Unauthorized");
  try {
    req.decoded = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return sendError(res, 403, "Forbidden");
  }
};

const verifyRole = (roles) => async (req, res, next) => {
  const email = req.decoded?.email;
  if (!email) return sendError(res, 401, "Unauthorized");

   const user = await usersCollection.findOne({ email });
  const effectiveRole = user?.role || "user";

  if (roles.includes(effectiveRole)) return next();
  return sendError(res, 403, `Forbidden: ${roles.join(" or ")} only`);
};

const verifyAdmin = verifyRole(["admin"]);
const verifyMember = verifyRole(["member"]);
const verifyUser = verifyRole(["user"]);
const verifyMemberOrUser = verifyRole(["member", "user"]);
const verifyMemberOrAdmin = verifyRole(["member", "admin"]);
const verifyAllRoles = verifyRole(["admin", "member", "user"]);

/* --------------------------------- Auth --------------------------------- */
app.post("/jwt", async (req, res) => {
  const { email } = req.body || {};
  if (!email) return sendError(res, 400, "Email required");
  const token = generateToken(email);
  res.cookie("token", token, cookieOptions);
  res.json({ message: "JWT issued" });
});

app.post("/logout", (req, res) => {
  res.clearCookie("token", { httpOnly: true, secure: isProd, sameSite: isProd ? "none" : "lax" });
  res.status(200).json({ message: "Logged out successfully" });
});

/* -------------------------------- Routes -------------------------------- */
// 🏢 Apartments
app.get("/apartments", async (req, res) => {
  try {
    const apartments = await apartmentsCollection.find().toArray();
    res.send(apartments);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Failed to fetch apartments");
  }
});

// 🎟️ Coupons
app.get("/coupons", async (req, res) => {
  try {
    const coupons = await db.collection("coupons").find().sort({ validTill: 1 }).toArray();
    res.send(coupons);
  } catch (err) {
    console.error("❌ Failed to fetch coupons:", err);
    sendError(res, 500, "Failed to fetch coupons");
  }
});

app.post("/coupons", verifyJWT, verifyAllRoles, async (req, res) => {
  try {
    const newCoupon = { ...req.body, createdAt: new Date() };
    const result = await db.collection("coupons").insertOne(newCoupon);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (error) {
    console.error("❌ Failed to add coupon:", error);
    sendError(res, 500, "Failed to add coupon");
  }
});

app.patch("/coupons/:id", verifyJWT, verifyAllRoles, async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, "Invalid coupon id");
  try {
    const result = await db.collection("coupons").updateOne({ _id: new ObjectId(id) }, { $set: req.body });
    if (!result.matchedCount) return sendError(res, 404, "Coupon not found");
    res.json({ message: "Coupon updated", modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error("❌ Failed to update coupon:", error);
    sendError(res, 500, "Failed to update coupon");
  }
});

app.delete("/coupons/:id", verifyJWT, verifyAllRoles, async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return sendError(res, 400, "Invalid coupon id");
  try {
    const result = await db.collection("coupons").deleteOne({ _id: new ObjectId(id) });
    if (!result.deletedCount) return sendError(res, 404, "Coupon not found");
    res.json({ message: "Coupon deleted", deletedCount: result.deletedCount });
  } catch (error) {
    console.error("❌ Failed to delete coupon:", error);
    sendError(res, 500, "Failed to delete coupon");
  }
});

app.post("/validate-coupon", async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ valid: false, message: "Coupon code is required" });
  try {
    const coupon = await db.collection("coupons").findOne({ code: String(code).toUpperCase().trim() });
    if (!coupon) return res.status(404).json({ valid: false, message: "Coupon not found" });
    const now = new Date();
    const validTill = coupon.validTill ? new Date(coupon.validTill) : null;
    if (validTill && validTill < now) {
      return res.status(400).json({ valid: false, message: "Coupon has expired" });
    }
    return res.status(200).json({ valid: true, discountPercentage: coupon.discount });
  } catch (error) {
    console.error("❌ Coupon validation error:", error);
    return res.status(500).json({ valid: false, message: "Internal Server Error" });
  }
});

// 🧾 Agreements
app.post("/agreements", verifyJWT, verifyAllRoles, async (req, res) => {
  const { floorNo, blockName, apartmentNo, rent, userEmail, userName } = req.body || {};
  if (!userEmail || !userName) return sendError(res, 400, "Missing user info");
  const existing = await agreementsCollection.findOne({ userEmail });
  if (existing) return sendError(res, 409, "Already applied");

  try {
    const result = await agreementsCollection.insertOne({
      userName, userEmail, floorNo, blockName, apartmentNo, rent, status: "pending", createdAt: new Date(),
    });
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Agreement creation failed");
  }
});

app.get("/agreements", verifyJWT, verifyAllRoles, async (req, res) => {
  try {
    const status = req.query?.status;
    const query = status ? { status } : {};
    const data = await agreementsCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.send(data);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Failed to fetch agreements");
  }
});

app.get("/agreements/member/:email", verifyJWT, async (req, res) => {
  try {
    const agreement = await agreementsCollection.findOne({
      userEmail: { $regex: new RegExp(`^${req.params.email}$`, "i") },
      status: "checked",
    });
    res.send(agreement || null);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Failed to fetch agreement");
  }
});

app.patch("/agreements/:id/status", verifyJWT, verifyAllRoles, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!status) return sendError(res, 400, "Status is required");
  if (!isValidObjectId(id)) return sendError(res, 400, "Invalid agreement id");
  try {
    const result = await agreementsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
    if (!result.matchedCount) return sendError(res, 404, "Agreement not found");
    res.json({ message: "Agreement status updated", modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error("❌ Failed to update agreement:", error);
    sendError(res, 500, "Internal Server Error");
  }
});

// 👤 Users
app.post("/users", async (req, res) => {
  const { email, name, role } = req.body || {};
  if (!email || !name) return sendError(res, 400, "Missing fields");
  const existing = await usersCollection.findOne({ email });
  if (existing) return sendError(res, 409, "User already exists");
  const result = await usersCollection.insertOne({ email, name, role: role || "user" });
  res.status(201).json({ insertedId: result.insertedId });
});

app.get("/users", verifyJWT, verifyAllRoles, async (req, res) => {
  try {
    const users = await usersCollection.find().toArray();
    res.send(users);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Failed to fetch users");
  }
});

app.get("/users/:email", verifyJWT, verifyAllRoles, async (req, res) => {
  try {
    const user = await usersCollection.findOne({ email: req.params.email });
    res.send({ exists: !!user });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Internal Server Error" });
  }
});

app.patch("/users/:email", verifyJWT, verifyAllRoles, async (req, res) => {
  const email = req.params.email;
  const updatedRole = req.body?.role;
  if (!updatedRole) return sendError(res, 400, "Role is required");
  try {
    const result = await db.collection("users").updateOne({ email }, { $set: { role: updatedRole } });
    res.send(result);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Failed to update user role");
  }
});

// 🔑 Get role
app.get("/users/role/:email", verifyJWT, async (req, res) => {
  try {
    if (!usersCollection) return res.status(503).json({ error: "Database not ready, try again" });
    const email = req.params.email;
    const user = await usersCollection.findOne({ email });
    return res.json({ role: user?.role || "user" });
  } catch (err) {
    console.error("❌ Failed to fetch user role:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// 📣 Announcements
app.post("/announcements", verifyJWT, verifyAllRoles, async (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !description) return sendError(res, 400, "Title and description required");
  try {
    const result = await db.collection("announcements").insertOne({
      title: String(title).trim(),
      description: String(description).trim(),
      createdAt: new Date(),
    });
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Failed to create announcement");
  }
});

app.get("/announcements", verifyJWT, async (req, res) => {
  try {
    const data = await db.collection("announcements").find().sort({ createdAt: -1 }).toArray();
    res.send(data);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Failed to fetch announcements");
  }
});

// 💳 Payments
app.post("/create-payment-intent", verifyJWT, verifyAllRoles, async (req, res) => {
  try {
    const amount = parseInt(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return sendError(res, 400, "Invalid amount");
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100,
      currency: "bdt",
      payment_method_types: ["card"],
    });
    res.send(paymentIntent.client_secret);
  } catch (err) {
    console.error(err);
    sendError(res, 500, err.message || "Payment intent failed");
  }
});

app.post("/payments", verifyJWT, verifyAllRoles, async (req, res) => {
  try {
    const payment = { ...req.body, createdAt: new Date() };
    const result = await db.collection("payments").insertOne(payment);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Payment saving failed");
  }
});

app.get("/payments/user/:email", verifyJWT, async (req, res) => {
  const email = req.params.email;
  try {
    const payments = await db.collection("payments").find({ email }).sort({ createdAt: -1 }).toArray();
    res.send(payments);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Failed to fetch payments");
  }
});

// 🚨 Notices
app.post("/notices/issue", async (req, res) => {
  const { userEmail, apartmentId, reason } = req.body || {};
  if (!userEmail) return sendError(res, 400, "userEmail required");
  const noticeCount = await db.collection("notices").countDocuments({ userEmail, status: "active" });
  const notice = { userEmail, apartmentId, reason, noticeCount: noticeCount + 1, status: "active", date: new Date() };
  await db.collection("notices").insertOne(notice);
  if (notice.noticeCount >= 3) {
    await db.collection("agreements").deleteOne({ userEmail });
    await db.collection("users").updateOne({ email: userEmail }, { $set: { role: "user" } });
  }
  res.status(201).send({ message: "Notice issued", notice });
});

app.get("/notices/users/:email", verifyJWT, verifyAllRoles, async (req, res) => {
  try {
    const notices = await db.collection("notices").find({ userEmail: req.params.email }).sort({ date: -1 }).toArray();
    res.send(notices);
  } catch (e) {
    console.error(e);
    sendError(res, 500, "Failed to fetch notices");
  }
});

// 🏢 Buildings
app.get("/buildings", async (req, res) => {
  try {
    const items = await db.collection("buildings").find().sort({ createdAt: -1 }).toArray();
    res.status(200).json(items);
  } catch (err) {
    console.error("❌ Failed to fetch buildings:", err);
    sendError(res, 500, "Failed to fetch buildings");
  }
});

// Health + Root
app.get("/health", (req, res) => res.json({ ok: true, env: NODE_ENV }));
app.get("/", (req, res) => res.send("Hello TowerTrack World!"));

// Minimal global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  sendError(res, 500, "Internal Server Error");
});

/* ------------------------- Export for Vercel & Local ------------------------- */
// On Vercel: export the handler (NO app.listen)
module.exports = app;

// Local dev only
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}
