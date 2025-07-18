// ✅ Optimized Express.js Server for TowerTrack

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-service-account.json");

const app = express();
const port = process.env.PORT || 3000;

// ✅ Firebase Admin Initialization
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// ✅ Middleware
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://towertrack-ph-assestwelve.netlify.app"
  ],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ✅ MongoDB Initialization
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let db, apartmentsCollection, agreementsCollection, usersCollection;

async function connectDB() {
  await client.connect();
  db = client.db("towerTrackDB");
  apartmentsCollection = db.collection("apartments");
  agreementsCollection = db.collection("agreements");
  usersCollection = db.collection("users");
  await cleanDuplicateAgreements();
  await db.command({ ping: 1 });
  console.log("✅ MongoDB Connected");
}

async function cleanDuplicateAgreements() {
  const duplicates = await agreementsCollection.aggregate([
    { $group: { _id: "$userEmail", count: { $sum: 1 }, docs: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  for (const dup of duplicates) {
    const idsToDelete = dup.docs.slice(1);
    await agreementsCollection.deleteMany({ _id: { $in: idsToDelete } });
    console.log(`🧹 Removed ${idsToDelete.length} duplicates for ${dup._id}`);
  }

  try {
    await agreementsCollection.createIndex({ userEmail: 1 }, { unique: true });
    console.log("✅ Unique index on userEmail created");
  } catch (err) {
    console.error("❌ Index creation error:", err);
  }
}

connectDB();

// ✅ JWT Middleware
function verifyJWT(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Forbidden" });
    req.decoded = decoded;
    next();
  });
}

// Optional JWT (for GET routes)
function optionalJWT(req, res, next) {
  const token = req.cookies.token;
  if (!token) return next();
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (!err) req.decoded = decoded;
    next();
  });
}

// ===================== 🔐 Auth Routes =====================
app.post("/jwt", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Firebase token required" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const jwtToken = jwt.sign(
      { email: decoded.email, name: decoded.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "2d" }
    );

    res.cookie("token", jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 24 * 2,
    });

    res.send({ success: true });
  } catch (err) {
    res.status(401).json({ error: "Invalid Firebase token" });
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
  res.send({ success: true });
});

// ===================== 🏢 Apartments =====================
app.get("/apartments", async (req, res) => {
  try {
    const apartments = await apartmentsCollection.find().toArray();
    res.send(apartments);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch apartments" });
  }
});

// ===================== 🧾 Agreements =====================
app.post("/agreements", verifyJWT, async (req, res) => {
  const { floorNo, blockName, apartmentNo, rent } = req.body;
  const { email: userEmail, name: userName } = req.decoded;

  if (!userEmail || !userName) return res.status(400).json({ error: "Missing user info" });

  const existing = await agreementsCollection.findOne({ userEmail });
  if (existing) return res.status(409).json({ message: "Already applied" });

  const agreement = {
    userName,
    userEmail,
    floorNo,
    blockName,
    apartmentNo,
    rent,
    status: "pending",
    createdAt: new Date(),
  };

  try {
    const result = await agreementsCollection.insertOne(agreement);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: "Agreement creation failed" });
  }
});

// ✅ Unified GET agreement (protected but no duplication)
app.get("/agreements", optionalJWT, async (req, res) => {
  try {
    const status = req.query.status;
    const query = status ? { status } : {};
    const data = await agreementsCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.send(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch agreements" });
  }
});

app.get("/agreements/member/:email", async (req, res) => {
  try {
    const agreement = await agreementsCollection.findOne({
      userEmail: { $regex: new RegExp(`^${req.params.email}$`, "i") },
      status: "checked",
    });
    res.send(agreement || null);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch agreement" });
  }
});

app.patch("/agreements/:id/status", verifyJWT, async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ message: "Missing status field" });

  const result = await agreementsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status, updatedAt: new Date() } }
  );

  if (result.modifiedCount > 0) res.send({ message: "Agreement updated" });
  else res.status(404).json({ message: "Not found or unchanged" });
});

// ===================== 👤 Users =====================
app.post("/users", verifyJWT, async (req, res) => {
  const { email, name, role } = req.body;
  if (!email || !name) return res.status(400).json({ message: "Missing fields" });

  const existing = await usersCollection.findOne({ email });
  if (existing) return res.status(409).json({ message: "User already exists" });

  const result = await usersCollection.insertOne({
    email,
    name,
    role: role || "user",
  });

  res.status(201).json({ insertedId: result.insertedId });
});

app.get("/users", async (req, res) => {
  try {
    const users = await usersCollection.find().toArray();
    res.send(users);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

app.get("/users/:email", async (req, res) => {
  try {
    const user = await usersCollection.findOne({ email: req.params.email });
    res.send({ exists: !!user });
  } catch (err) {
    res.status(500).send({ error: "Internal Server Error" });
  }
});

app.get("/users/role/:email", verifyJWT, async (req, res) => {
  const user = await usersCollection.findOne({ email: req.params.email });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.send({ role: user.role });
});

app.patch("/users/role", verifyJWT, async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(400).json({ message: "Missing fields" });

  const result = await usersCollection.updateOne(
    { email },
    { $set: { role, updatedAt: new Date() } }
  );

  if (result.modifiedCount > 0) res.send({ message: "Role updated" });
  else res.status(404).json({ message: "User not found" });
});

// ===================== 📣 Announcements =====================
app.post("/announcements", async (req, res) => {
  const { title, description } = req.body;
  if (!title || !description)
    return res.status(400).json({ message: "Title and description required" });

  const result = await db.collection("announcements").insertOne({
    title: title.trim(),
    description: description.trim(),
    createdAt: new Date(),
  });

  res.status(201).json({ insertedId: result.insertedId });
});

app.get("/announcements", async (req, res) => {
  try {
    const data = await db.collection("announcements").find().sort({ createdAt: -1 }).toArray();
    res.send(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch announcements" });
  }
});

// ===================== 🎟️ Coupons =====================
app.post("/coupons", verifyJWT, async (req, res) => {
  const { title, description, discount, validTill, code } = req.body;
  if (!title || !description || !discount || !validTill || !code)
    return res.status(400).json({ message: "Missing required fields" });

  const coupon = {
    title,
    description,
    discount: Number(discount),
    validTill,
    code,
    createdAt: new Date(),
  };

  const result = await db.collection("coupons").insertOne(coupon);
  res.status(201).json({ insertedId: result.insertedId });
});

app.get("/coupons", verifyJWT, async (req, res) => {
  try {
    const coupons = await db.collection("coupons").find().sort({ createdAt: -1 }).toArray();
    res.send(coupons);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch coupons" });
  }
});

app.patch("/coupons/:id", verifyJWT, async (req, res) => {
  const { title, description, discount, validTill, code } = req.body;
  const result = await db.collection("coupons").updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        title,
        description,
        discount: Number(discount),
        validTill,
        code,
        updatedAt: new Date(),
      },
    }
  );

  if (result.modifiedCount > 0) res.send({ message: "Coupon updated" });
  else res.status(404).json({ message: "Coupon not found" });
});

app.delete("/coupons/:id", verifyJWT, async (req, res) => {
  const result = await db.collection("coupons").deleteOne({ _id: new ObjectId(req.params.id) });
  if (result.deletedCount > 0) res.send({ message: "Coupon deleted" });
  else res.status(404).json({ message: "Coupon not found" });
});

// ===================== ⚙️ Base =====================
app.get("/", (req, res) => {
  res.send("Hello TowerTrack World!");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
