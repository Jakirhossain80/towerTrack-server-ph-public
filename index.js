require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ["http://localhost:5173", "https://your-frontend-domain.com"],
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// MongoDB Connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
let db, apartmentsCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("towerTrackDB");
    apartmentsCollection = db.collection("apartments");
    await db.command({ ping: 1 });
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}
connectDB();

// 🔐 JWT Sign Route (Call this after Firebase Login)
app.post("/jwt", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send({ error: "Email is required" });

  const token = jwt.sign({ email }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "2d",
  });

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 1000 * 60 * 60 * 24 * 2, // 2 days
  });

  res.send({ success: true });
});

// 🔒 JWT Verification Middleware
function verifyJWT(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).send({ error: "Unauthorized" });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send({ error: "Forbidden" });
    req.user = decoded;
    next();
  });
}

// 🏢 Protected Route Example
app.get("/apartments", verifyJWT, async (req, res) => {
  try {
    const apartments = await apartmentsCollection.find().toArray();
    res.send(apartments);
  } catch (error) {
    res.status(500).send({ error: "Failed to fetch apartments" });
  }
});

// 🧼 Optional: Logout (Clear the cookie)
app.post("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
  res.send({ success: true });
});

// Root
app.get("/", (req, res) => {
  res.send("Hello TowerTrack World!");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
