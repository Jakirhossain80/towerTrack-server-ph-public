require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

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

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db, apartmentsCollection, agreementsCollection, usersCollection;

async function connectDB() {
  db = client.db("towerTrackDB");
  apartmentsCollection = db.collection("apartments");
  agreementsCollection = db.collection("agreements");
  usersCollection = db.collection("users");
  await cleanDuplicateAgreements();
  await db.command({ ping: 1 });
  console.log("✅ MongoDB Connected");
}

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

// ===================== 🏢 Apartments =====================
app.get("/apartments", async (req, res) => {
  try {
    const apartments = await apartmentsCollection.find().toArray();
    res.send(apartments);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch apartments" });
  }
});

// ===================== 🎟️ Public Coupons =====================
app.get("/coupons", async (req, res) => {
  try {
    const coupons = await db
      .collection("coupons")
      .find()
      .sort({ validTill: 1 })
      .toArray();
    res.send(coupons);
  } catch (err) {
    console.error("❌ Failed to fetch coupons:", err);
    res.status(500).json({ error: "Failed to fetch coupons" });
  }
});

// ===================== 🧾 Agreements =====================
app.post("/agreements", async (req, res) => {
  const { floorNo, blockName, apartmentNo, rent, userEmail, userName } =
    req.body;

  if (!userEmail || !userName)
    return res.status(400).json({ error: "Missing user info" });

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

app.get("/agreements", async (req, res) => {
  try {
    const status = req.query.status;
    const query = status ? { status } : {};
    const data = await agreementsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
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

// ✅ PATCH: Update agreement status by ID
app.patch("/agreements/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ message: "Status is required" });
  }

  try {
    const result = await agreementsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Agreement not found" });
    }

    res.json({ message: "Agreement status updated", modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error("❌ Failed to update agreement:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});


// ===================== 👤 Users =====================
app.post("/users", async (req, res) => {
  const { email, name, role } = req.body;
  if (!email || !name)
    return res.status(400).json({ message: "Missing fields" });

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

app.patch("/users/:email", async (req, res) => {
  const email = req.params.email;
  const updatedRole = req.body.role;
  const result = await db.collection("users").updateOne(
    { email },
    { $set: { role: updatedRole } }
  );
  res.send(result);
});

// ===================== 🔑 Get User Role by Email =====================
// ✅ Get role of a user by email with fallback
app.get("/users/role/:email", async (req, res) => {
  const email = req.params.email;
  try {
    const user = await usersCollection.findOne({ email });

    // Always respond with a role — default to "user"
    const role = user?.role || "user";

    res.json({ role });
  } catch (err) {
    console.error("❌ Failed to fetch user role:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
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
    const data = await db
      .collection("announcements")
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    res.send(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch announcements" });
  }
});

// ===================== 💳 Payments =====================
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: parseInt(amount) * 100,
      currency: "bdt",
      payment_method_types: ["card"],
    });
    res.send(paymentIntent.client_secret);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/payments", async (req, res) => {
  try {
    const payment = req.body;
    const result = await db.collection("payments").insertOne(payment);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: "Payment saving failed" });
  }
});

app.get("/payments/user/:email", async (req, res) => {
  const email = req.params.email;

  try {
    const payments = await db
      .collection("payments")
      .find({ email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(payments);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch payments" });
  }
});

// ===================== 🚨 Notices =====================
app.post("/notices/issue", async (req, res) => {
  const { userEmail, apartmentId, reason } = req.body;

  const noticeCount = await db.collection("notices").countDocuments({
    userEmail,
    status: "active",
  });

  const notice = {
    userEmail,
    apartmentId,
    reason,
    noticeCount: noticeCount + 1,
    status: "active",
    date: new Date(),
  };

  await db.collection("notices").insertOne(notice);

  if (notice.noticeCount >= 3) {
    await db.collection("agreements").deleteOne({ userEmail });
    await db.collection("users").updateOne(
      { email: userEmail },
      { $set: { role: "user" } }
    );
  }

  res.status(201).send({ message: "Notice issued", notice });
});

app.get("/notices/user/:email", async (req, res) => {
  const notices = await db
    .collection("notices")
    .find({ userEmail: req.params.email })
    .sort({ date: -1 })
    .toArray();
  res.send(notices);
});

app.get("/", (req, res) => {
  res.send("Hello TowerTrack World!");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
