require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection URI (replace <username> and <password> from .env)
const uri = process.env.MONGODB_URI;



// Create MongoDB client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Global variables for DB and collection
let db, apartmentsCollection;

// Connect to MongoDB and initialize collection references
async function connectDB() {
  try {
    await client.connect();
    db = client.db("towerTrackDB"); // Use your main database
    apartmentsCollection = db.collection("apartments"); // Access the apartments collection

    // Confirm successful connection
    await db.command({ ping: 1 });
    console.log("✅ Connected to MongoDB and towerTrackDB database.");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
  }
}

// Connect when server starts
connectDB();

// Root route
app.get("/", (req, res) => {
  res.send("Hello TowerTrack World!");
});

// Example GET route to fetch apartments (optional/test purpose)
app.get("/apartments", async (req, res) => {
  try {
    const apartments = await apartmentsCollection.find().toArray();
    res.send(apartments);
  } catch (error) {
    res.status(500).send({ error: "Failed to fetch apartments" });
  }
});

// Start server
app.listen(port, () => {
  console.log(`🚀 TowerTrack server listening on port ${port}`);
});
