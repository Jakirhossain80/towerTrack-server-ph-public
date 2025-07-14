require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-service-account.json"); // 🔐 Ensure this is secured and gitignored

// 🔐 Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const app = express();
const port = process.env.PORT || 3000;

// 🧩 Middleware
app.use(cors({
  origin: [
    "http://localhost:5173", // local frontend
    "https://towertrack-ph-assestwelve.netlify.app" // ✅ deployed frontend
  ],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// 🔌 MongoDB Setup
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;
let apartmentsCollection;
let agreementsCollection;

// 🔧 Clean up duplicate agreements and create unique index
async function cleanDuplicateAgreements() {
  const duplicates = await agreementsCollection
    .aggregate([
      {
        $group: {
          _id: "$userEmail",
          count: { $sum: 1 },
          docs: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  for (const dup of duplicates) {
    const idsToDelete = dup.docs.slice(1); // Keep one, delete others
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

    // Call the cleaner here ONCE
    await cleanDuplicateAgreements();

    await db.command({ ping: 1 });
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}

connectDB();

// 🔐 Updated JWT Endpoint (verifies Firebase token)
app.post("/jwt", async (req, res) => {
  const { token } = req.body;

  if (!token)
    return res.status(400).json({ error: "Firebase ID token is required" });

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

// 🔐 JWT Middleware
function verifyJWT(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).send({ error: "Unauthorized" });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send({ error: "Forbidden" });
    req.decoded = decoded; // Access req.decoded.email and req.decoded.name
    next();
  });
}

// 🏢 Public GET /apartments route
app.get("/apartments", async (req, res) => {
  try {
    const apartments = await apartmentsCollection.find().toArray();
    res.send(apartments);
  } catch (error) {
    res.status(500).send({ error: "Failed to fetch apartments" });
  }
});

// 📩 Protected POST /agreements route
app.post("/agreements", verifyJWT, async (req, res) => {
  const { floorNo, blockName, apartmentNo, rent } = req.body;
  const { email: userEmail, name: userName } = req.decoded;

  if (!userEmail || !userName) {
    return res.status(400).json({ error: "Missing user info in token" });
  }

  try {
    const existingAgreement = await agreementsCollection.findOne({ userEmail });

    if (existingAgreement) {
      return res
        .status(409)
        .json({ message: "You have already applied for an apartment." });
    }

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
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ message: "Duplicate application detected." });
    }
    res.status(500).json({ error: "Failed to submit agreement" });
  }
});

// 🚪 Logout
app.post("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
  res.send({ success: true });
});

// 🌐 Root Route
app.get("/", (req, res) => {
  res.send("Hello TowerTrack World!");
});

// 🚀 Start Server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
