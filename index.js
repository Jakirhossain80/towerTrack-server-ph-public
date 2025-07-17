// ✅ Full Updated Express.js Server (TowerTrack)

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

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://towertrack-ph-assestwelve.netlify.app",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let db, apartmentsCollection, agreementsCollection, usersCollection;

async function cleanDuplicateAgreements() {
  const duplicates = await agreementsCollection
    .aggregate([
      { $group: { _id: "$userEmail", count: { $sum: 1 }, docs: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  for (const dup of duplicates) {
    const idsToDelete = dup.docs.slice(1);
    await agreementsCollection.deleteMany({ _id: { $in: idsToDelete } });
    console.log(`🧹 Removed ${idsToDelete.length} duplicates for ${dup._id}`);
  }

  try {
    await agreementsCollection.createIndex({ userEmail: 1 }, { unique: true });
    console.log("✅ Unique index created on userEmail");
  } catch (err) {
    console.error("❌ Index creation failed:", err);
  }
}

async function connectDB() {
  try {
    await client.connect();
    db = client.db("towerTrackDB");
    apartmentsCollection = db.collection("apartments");
    agreementsCollection = db.collection("agreements");
    usersCollection = db.collection("users");
    await cleanDuplicateAgreements();
    await db.command({ ping: 1 });
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}

connectDB();

function verifyJWT(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).send({ error: "Unauthorized" });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send({ error: "Forbidden" });
    req.decoded = decoded;
    next();
  });
}

app.post("/jwt", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Firebase ID token is required" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const { email, name } = decoded;
    const jwtToken = jwt.sign({ email, name }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "2d",
    });

    res.cookie("token", jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 24 * 2,
    });

    res.send({ success: true });
  } catch (error) {
    console.error("Firebase token verification failed:", error);
    res.status(401).json({ error: "Invalid Firebase token" });
  }
});

// ✅ GET all apartments
app.get("/apartments", async (req, res) => {
  try {
    const apartments = await db.collection("apartments").find().toArray();
    res.send(apartments);
  } catch (error) {
    console.error("Error fetching apartments:", error);
    res.status(500).send({ message: "Failed to fetch apartments" });
  }
});

app.post("/agreements", verifyJWT, async (req, res) => {
  const { floorNo, blockName, apartmentNo, rent } = req.body;
  const { email: userEmail, name: userName } = req.decoded;
  if (!userEmail || !userName) return res.status(400).json({ error: "Missing user info in token" });

  try {
    const existing = await agreementsCollection.findOne({ userEmail });
    if (existing) return res.status(409).json({ message: "You have already applied." });

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
    const result = await agreementsCollection.insertOne(agreement);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (error) {
    if (error.code === 11000)
      return res.status(409).json({ message: "Duplicate application detected." });
    res.status(500).json({ error: "Failed to submit agreement" });
  }
});

app.post("/users", verifyJWT, async (req, res) => {
  const { email, name, role } = req.body;
  if (!email || !name) return res.status(400).json({ message: "Missing fields" });

  const existing = await usersCollection.findOne({ email });
  if (existing) return res.status(409).json({ message: "User already exists" });

  const newUser = { email, name, role: role || "user" };
  const result = await usersCollection.insertOne(newUser);
  res.status(201).json({ message: "User created", insertedId: result.insertedId });
});

app.get("/users/role/:email", verifyJWT, async (req, res) => {
  const user = await usersCollection.findOne({ email: req.params.email });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.send({ role: user.role });
});

app.post("/announcements", async (req, res) => {
  const { title, description } = req.body;
  if (!title || !description)
    return res.status(400).json({ message: "Title and description are required." });

  const result = await db.collection("announcements").insertOne({
    title: title.trim(),
    description: description.trim(),
    createdAt: new Date(),
  });

  res.status(201).json({ message: "Announcement posted", insertedId: result.insertedId });
});

app.get("/announcements", async (req, res) => {
  try {
    const data = await db.collection("announcements").find().sort({ createdAt: -1 }).toArray();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch announcements" });
  }
});

app.post("/coupons", verifyJWT, async (req, res) => {
  const { title, description, discount, validTill, code } = req.body;
  if (!title || !description || !discount || !validTill || !code)
    return res.status(400).json({ message: "Missing required fields" });

  const coupon = { title, description, discount: Number(discount), validTill, code, createdAt: new Date() };
  const result = await db.collection("coupons").insertOne(coupon);
  res.status(201).json({ message: "Coupon created", insertedId: result.insertedId });
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
  else res.status(404).json({ message: "Coupon not found or unchanged" });
});

app.delete("/coupons/:id", verifyJWT, async (req, res) => {
  const result = await db.collection("coupons").deleteOne({ _id: new ObjectId(req.params.id) });
  if (result.deletedCount > 0) res.send({ message: "Coupon deleted" });
  else res.status(404).json({ message: "Coupon not found" });
});

app.get("/agreements", verifyJWT, async (req, res) => {
  const status = req.query.status;
  const query = status ? { status } : {};
  const data = await agreementsCollection.find(query).sort({ createdAt: -1 }).toArray();
  res.send(data);
});

app.patch("/agreements/:id/status", verifyJWT, async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ message: "Missing status field" });

  const result = await agreementsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status, updatedAt: new Date() } }
  );

  if (result.modifiedCount > 0) res.send({ message: "Agreement status updated" });
  else res.status(404).json({ message: "Agreement not found or unchanged" });
});

app.patch("/users/role", verifyJWT, async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(400).json({ message: "Missing email or role" });

  const result = await usersCollection.updateOne({ email }, { $set: { role, updatedAt: new Date() } });
  if (result.modifiedCount > 0) res.send({ message: "User role updated" });
  else res.status(404).json({ message: "User not found or role unchanged" });
});



app.get("/agreements/member/:email", async (req, res) => {
  try {
    const email = req.params.email;

    const agreement = await db.collection("agreements").findOne({
      userEmail: { $regex: new RegExp(`^${email}$`, "i") },
      status: "checked",
    });

    console.log("Agreement Found:", agreement);

    if (!agreement) {
      return res.status(200).send(null);
    }

    res.send(agreement);
  } catch (error) {
    console.error("GET /agreements/member/:email error:", error);
    res.status(500).send({ message: "Failed to fetch agreement" });
  }
});




app.get("/users/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const existingUser = await usersCollection.findOne({ email }); // ✅ Already initialized globally

    if (existingUser) {
      return res.send({ exists: true });
    } else {
      return res.send({ exists: false });
    }
  } catch (err) {
    res.status(500).send({ error: "Internal Server Error" });
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

app.get("/", (req, res) => {
  res.send("Hello TowerTrack World!");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
