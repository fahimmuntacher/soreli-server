const express = require("express");
const { MongoClient, ServerApiVersion } = require("mongodb");
const stripe = require("stripe")(`${process.env.STRIPE_KEY}`);

const app = express();
require("dotenv").config();
const cors = require("cors");
const admin = require("firebase-admin");
const port = 3000;

var serviceAccount = require("./firebase_admin_sdk_key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middlewear
app.use(express.json());
app.use(cors());

// jwt verification middlewear
const verifyFireBaseToke = async (req, res, next) => {
  const token = req.headers.authorization;
  // console.log(token);
  if (!token) {
    return res.status(401).send({ message: "unauthorized acces" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASS}@cluster0.8xsgmgv.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const myDb = client.db("soreli_db");
    const usersCollection = myDb.collection("users");
    const lessonsCollection = myDb.collection("lessons");

    // users post
    app.post("/users", async (req, res) => {
      const usersDetail = req.body;
      usersDetail.role = "user";
      usersDetail.isPremium = false;
      usersDetail.createdAt = new Date();
      const email = usersDetail?.email;
      const existingUser = await usersCollection.findOne({ email });
      if (existingUser) {
        return res.send({ message: "User exist" });
      }
      const result = await usersCollection.insertOne(usersDetail);
      res.send(result);
    });

    // users get
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role, isPremium: user?.isPremium });
    });

    // lessons API

    // lessons post
    app.post("/lessons", verifyFireBaseToke, async (req, res) => {
      const lessonsDetail = req.body;
      // console.log(lessonsDetail);
      lessonsDetail.createdAt = new Date();
      lessonsDetail.isFeatured = false;
      const email = lessonsDetail?.authorEmail;
      const userRole = await usersCollection.findOne({ email });
      if (userRole?.role !== "user") {
        return res.status(403).send({ message: "forbidden access" });
      }
      const result = await lessonsCollection.insertOne(lessonsDetail);
      res.send(result);
    });

    // stripe payment integration
    app.post(
      "/create-checkout-session",
      verifyFireBaseToke,
      async (req, res) => {
        try {
          const { price } = req.body;
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
              {
                price_data: {
                  currency: "bdt",
                  unit_amount: Number(price) * 100, // 1500 BDT → 150000
                  product_data: {
                    name: "Premium Membership - Lifetime Access",
                  },
                },
                quantity: 1,
              },
            ],
            userEmail : req.decoded_email,
            mode: "payment",
            success_url: `${process.env.DOMAIN_NAME}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.DOMAIN_NAME}/checkout/cancel`,
          });

          res.json({ url: session.url }); // frontend will redirect
        } catch (error) {
          console.error(error);
          res.status(500).json({ message: "Stripe session creation failed" });
        }
      }
    );

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
