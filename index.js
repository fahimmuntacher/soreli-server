const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
require("dotenv").config();
const cors = require("cors");
const CryptoJS = require("crypto-js");
const stripe = require("stripe")(`${process.env.STRIPE_KEY}`);
const admin = require("firebase-admin");
const port = 3000;

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const time = Date.now().toString(36).toUpperCase();
  const randomWordArray = CryptoJS.lib.WordArray.random(3);
  const randomHash = randomWordArray.toString(CryptoJS.enc.Hex).toUpperCase();
  return `PKG-${time}-${randomHash}`;
}

// middlewear
app.use(express.json());
app.use(cors());

// jwt verification middlewear
const verifyFirebaseToken = async (req, res, next) => {
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
    const paymentsCollection = myDb.collection("payments");
    const commentsCollection = myDb.collection("comments");
    const reportsCollection = myDb.collection("reports");

    // get user id by email helper function
    const getUserIdByEmail = async (email) => {
      const user = await usersCollection.findOne(
        { email },
        { projection: { _id: 1 } }
      );

      return user?._id || null;
    };

    // admin verify middlewear
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });

      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Admin access only" });
      }

      next();
    };

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

    // user profile get
    app.get(
      "/lessons/by-user/paginated",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const email = req.decoded_email;

          const page = parseInt(req.query.page) || 1;
          const limit = parseInt(req.query.limit) || 8;
          const skip = (page - 1) * limit;

          // security check
          if (email !== req.query.email) {
            return res.status(403).send({ message: "Forbidden access" });
          }

          const total = await lessonsCollection.countDocuments({
            authorEmail: email,
          });

          const lessons = await lessonsCollection
            .find({ authorEmail: email })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .project({
              title: 1,
              category: 1,
              tone: 1,
              createdAt: 1,
              image: 1,
            })
            .toArray();

          res.send({
            success: true,
            lessons,
            pagination: {
              total,
              page,
              totalPages: Math.ceil(total / limit),
            },
          });
        } catch (error) {
          console.error("PAGINATED LESSON ERROR:", error);
          res.status(500).send({ message: "Failed to fetch lessons" });
        }
      }
    );

    // admin stats get

    app.get(
      "/admin/stats",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          const [totalUsers, totalLessons, reportedLessons, todayLessons] =
            await Promise.all([
              usersCollection.countDocuments(),
              lessonsCollection.countDocuments({ privacy: "public" }),
              reportsCollection.countDocuments(),
              lessonsCollection.countDocuments({ createdAt: { $gte: today } }),
            ]);

          res.send({
            totalUsers,
            totalLessons,
            reportedLessons,
            todayLessons,
          });
        } catch (error) {
          console.error("ADMIN STATS ERROR:", error);
          res.status(500).send({ message: "Failed to load admin stats" });
        }
      }
    );

    // lesson growth data for admin
    app.get(
      "/admin/lesson-growth",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const data = await lessonsCollection
            .aggregate([
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$createdAt",
                    },
                  },
                  lessons: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
              {
                $project: {
                  date: "$_id",
                  lessons: 1,
                  _id: 0,
                },
              },
            ])
            .toArray();

          res.send(data);
        } catch (error) {
          console.error("LESSON GROWTH ERROR:", error);
          res.status(500).send({ message: "Failed to load lesson growth" });
        }
      }
    );

    // user growth data for admin
    app.get(
      "/admin/user-growth",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const data = await usersCollection
            .aggregate([
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$createdAt",
                    },
                  },
                  users: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
              {
                $project: {
                  date: "$_id",
                  users: 1,
                  _id: 0,
                },
              },
            ])
            .toArray();

          res.send(data);
        } catch (error) {
          console.error("USER GROWTH ERROR:", error);
          res.status(500).send({ message: "Failed to load user growth" });
        }
      }
    );

    // top contributors for admin
    app.get(
      "/admin/top-contributors",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const contributors = await lessonsCollection
            .aggregate([
              {
                $group: {
                  _id: "$authorEmail",
                  lessonsCount: { $sum: 1 },
                },
              },
              { $sort: { lessonsCount: -1 } },
              { $limit: 5 },
              {
                $lookup: {
                  from: "users",
                  localField: "_id",
                  foreignField: "email",
                  as: "user",
                },
              },
              { $unwind: "$user" },
              {
                $project: {
                  email: "$_id",
                  name: "$user.name",
                  photoURL: "$user.photoURL",
                  lessonsCount: 1,
                  _id: 0,
                },
              },
            ])
            .toArray();

          res.send(contributors);
        } catch (error) {
          console.error("TOP CONTRIBUTORS ERROR:", error);
          res.status(500).send({ message: "Failed to load contributors" });
        }
      }
    );

    // user profile update

    app.patch("/user/:email", verifyFirebaseToken, async (req, res) => {
      const email = req.params.email;
      const updatedData = req.body;

      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const result = await usersCollection.updateOne(
        { email },
        { $set: updatedData }
      );
      res.send(result);
    });

    // lessons API

    // lessons post
    app.post("/lessons", verifyFirebaseToken, async (req, res) => {
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

    // get all lessons
    app.get("/lessons/public", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 6;
      const skip = (page - 1) * limit;
      const query = { privacy: "public" };
      const total = await lessonsCollection.countDocuments(query);
      const lessons = await lessonsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        lessons,
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
      });
    });

    // get lessons by user email
    app.get("/lessons/by-user", verifyFirebaseToken, async (req, res) => {
      try {
        const email = req.query.email;
        // console.log(email);

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden access" });
        }
        const lessons = await lessonsCollection
          .find({ authorEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send({
          success: true,
          lessons,
        });
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Failed to fetch lessons" });
      }
    });

    // get single lesson
    app.get("/lessons/public/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const cursor = await lessonsCollection.findOne(query);

      res.send(cursor);
    });

    // post like api
    app.patch("/lessons/like/:id", verifyFirebaseToken, async (req, res) => {
      const lessonId = req.params.id;

      const email = req.decoded_email;

      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(lessonId),
      });

      const alreadyLiked = lesson.likes?.includes(email);

      const update = alreadyLiked
        ? {
            $pull: { likes: email },
            $inc: { likesCount: -1 },
          }
        : {
            $addToSet: { likes: email },
            $inc: { likesCount: 1 },
          };

      await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        update
      );

      res.send({ liked: !alreadyLiked });
    });

    // update lesson api
    app.put("/lessons/:id", verifyFirebaseToken, async (req, res) => {
      const lessonId = req.params.id;
      const email = req.decoded_email;
      const updatedLesson = req.body;
      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(lessonId),
      });
      if (!lesson || lesson.authorEmail !== email) {
        return res.status(403).send({ message: "Forbidden access" });
      }
      await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $set: updatedLesson }
      );
      res.send({ success: true });
    });

    // patch lesson visibility api
    app.patch(
      "/lessons/:id/visibility",
      verifyFirebaseToken,
      async (req, res) => {
        const lessonId = req.params.id;
        // console.log(lessonId);
        const email = req.decoded_email;
        const { privacy } = req.body;

        if (!["public", "private"].includes(privacy)) {
          return res.status(400).send({ message: "Invalid privacy value" });
        }

        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(lessonId),
        });

        if (!lesson || lesson.authorEmail !== email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $set: { privacy } }
        );

        res.send({ success: true });
      }
    );

    // patch lesson access api
    app.patch("/lessons/:id/access", verifyFirebaseToken, async (req, res) => {
      const lessonId = req.params.id;
      // console.log("access level", lessonId);
      const email = req.decoded_email;
      const { access } = req.body;

      if (!["free", "premium"].includes(access)) {
        return res.status(400).send({ message: "Invalid access value" });
      }

      const user = await usersCollection.findOne({ email });

      if (!user?.isPremium) {
        return res.status(403).send({ message: "Premium required" });
      }

      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(lessonId),
      });

      if (!lesson || lesson.authorEmail !== email) {
        return res.status(403).send({ message: "Forbidden access" });
      }

      await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $set: { access } }
      );

      res.send({ success: true });
    });

    // comment post api
    app.post("/lessons/:id/comments", verifyFirebaseToken, async (req, res) => {
      const lessonId = req.params.id;
      const email = req.decoded_email;
      const { comment, userName, userPhoto } = req.body;

      if (!comment?.trim()) {
        return res.status(400).send({ message: "Comment required" });
      }

      const newComment = {
        lessonId: new ObjectId(lessonId),
        userEmail: email,
        userName,
        userPhoto,
        comment,
        createdAt: new Date(),
      };

      const result = await commentsCollection.insertOne(newComment);
      res.send(result);
    });

    // comment get api
    app.get("/lessons/:id/comments", async (req, res) => {
      const lessonId = req.params.id;

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 5;
      const skip = (page - 1) * limit;

      const query = { lessonId: new ObjectId(lessonId) };

      const total = await commentsCollection.countDocuments(query);

      const comments = await commentsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        comments,
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
      });
    });

    // favourite lessons post api
    app.patch(
      "/lessons/favorite/:id",
      verifyFirebaseToken,
      async (req, res) => {
        const email = req.decoded_email;
        const lessonId = req.params.id;

        const userId = await getUserIdByEmail(email);

        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(lessonId),
        });

        const alreadySaved = lesson.favorites?.includes(email);

        const update = alreadySaved
          ? {
              $pull: { favorites: email },
              $inc: { favoritesCount: -1 },
            }
          : {
              $addToSet: { favorites: email },
              $inc: { favoritesCount: 1 },
            };

        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          update
        );

        res.send({ saved: !alreadySaved });
      }
    );

    // get favourite lessons with filters
    app.get("/lessons/favorites", verifyFirebaseToken, async (req, res) => {
      try {
        const { email, category, tone } = req.query;
        // console.log(email, category, tone);

        // security check
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        // base query
        const query = {
          favorites: email,
          privacy: "public",
        };

        // optional filters
        if (category && category !== "all") {
          query.category = category;
        }

        if (tone && tone !== "all") {
          query.tone = tone;
        }

        const favorites = await lessonsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(favorites);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to load favorites" });
      }
    });

    // delte favourite lesson api
    const { ObjectId } = require("mongodb");

    // remove favorite lesson api
    app.patch(
      "/lessons/remove-favorite/:id",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const lessonId = req.params.id;
          const { email } = req.body;

          if (email !== req.decoded_email) {
            return res.status(403).send({ message: "Forbidden access" });
          }

          const filter = { _id: new ObjectId(lessonId) };
          const lesson = await lessonsCollection.findOne(filter);

          if (!lesson) {
            return res.status(404).send({ message: "Lesson not found" });
          }

          // check if already not in favorites
          if (!lesson.favorites?.includes(email)) {
            return res.send({
              message: "Lesson already removed from favorites",
            });
          }

          const update = {
            $pull: { favorites: email },
            $inc: { favoritesCount: -1 },
          };

          await lessonsCollection.updateOne(filter, update);

          res.send({ success: true });
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Failed to remove favorite" });
        }
      }
    );

    // report api
    app.post("/lessons/report/:id", verifyFirebaseToken, async (req, res) => {
      const { reason } = req.body;
      const email = req.decoded_email;
      const lessonId = req.params.id;

      if (!email || !reason) {
        return res.status(400).send({ message: "Missing data" });
      }

      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }

      await reportsCollection.insertOne({
        lessonId: new ObjectId(lessonId),
        reporterUserId: user._id,
        reporterEmail: email,
        reason,
        createdAt: new Date(),
      });

      res.send({ message: "Reported successfully" });
    });

    // get reports post api
    app.get(
      "/admin/reported-lessons",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await reportsCollection
            .aggregate([
              {
                $group: {
                  _id: "$lessonId",
                  reportCount: { $sum: 1 },
                  reports: {
                    $push: {
                      reason: "$reason",
                      reporterEmail: "$reporterEmail",
                      createdAt: "$createdAt",
                    },
                  },
                },
              },
              {
                $lookup: {
                  from: "lessons",
                  localField: "_id",
                  foreignField: "_id",
                  as: "lesson",
                },
              },
              { $unwind: "$lesson" },
              {
                $project: {
                  lessonId: "$_id",
                  reportCount: 1,
                  reports: 1,
                  title: "$lesson.title",
                  authorEmail: "$lesson.authorEmail",
                  createdAt: "$lesson.createdAt",
                },
              },
              { $sort: { reportCount: -1 } },
            ])
            .toArray();

          res.send(result);
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Failed to fetch reported lessons" });
        }
      }
    );

    // update reports
    app.patch(
      "/admin/reported-lessons/:lessonId/ignore",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const { lessonId } = req.params;

        await reportsCollection.deleteMany({
          lessonId: new ObjectId(lessonId),
        });

        res.send({ success: true });
      }
    );

    // get similar lessons
    app.get("/lessons/similar/:id", async (req, res) => {
      const lessonId = req.params.id;

      const currentLesson = await lessonsCollection.findOne({
        _id: new ObjectId(lessonId),
      });

      if (!currentLesson) {
        return res.status(404).send({ message: "Lesson not found" });
      }

      const { category, tone } = currentLesson;

      const similarLessons = await lessonsCollection
        .find({
          _id: { $ne: new ObjectId(lessonId) },
          $or: [{ category: category }, { tone: tone }],
          visibility: "public",
        })
        .limit(6)
        // .project({
        //   title: 1,
        //   category: 1,
        //   tone: 1,
        //   image: 1,
        //   likesCount: 1,
        //   favoritesCount: 1,
        //   authorName: 1,
        //   createdAt: 1,
        // })
        .toArray();

      res.send(similarLessons);
    });

    // delete lesson api
    app.delete("/lessons/:id", verifyFirebaseToken, async (req, res) => {
      const lessonId = req.params.id;
      // console.log(lessonId);
      const email = req.decoded_email;
      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(lessonId),
      });
      if (!lesson || lesson.authorEmail !== email) {
        return res.status(403).send({ message: "Forbidden access" });
      }
      const result = await lessonsCollection.deleteOne({
        _id: new ObjectId(lessonId),
      });
      res.send(result);
    });

    // get favourite lessons
    app.get("/lessons/favorites", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "Forbidden access" });
      }
      const favorites = await lessonsCollection
        .find({
          favorites: email,
          privacy: "public",
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(favorites);
    });

    // get lesson by author email
    app.get("/my-lessons", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;

      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "Forbidden access" });
      }

      const lessons = await lessonsCollection
        .find({ authorEmail: email })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(lessons);
    });

    // stripe payment integration
    app.post(
      "/create-checkout-session",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { price, email } = req.body;
          const amount = parseInt(price * 100);
          console.log(price);
          if (email !== req.decoded_email) {
            return res.status(403).send({ message: "forbidden access" });
          }
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
              {
                price_data: {
                  currency: "bdt",
                  unit_amount: amount,
                  product_data: {
                    name: "Premium Membership - Lifetime Access",
                  },
                },
                quantity: 1,
              },
            ],
            customer_email: req.decoded_email,
            mode: "payment",
            success_url: `${process.env.DOMAIN_NAME}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.DOMAIN_NAME}/checkout/cancel`,
          });

          res.send({ url: session.url });
        } catch (error) {
          console.error("STRIPE ERROR:", error);
          res
            .status(500)
            .json({ message: "Stripe session creation failed", error });
        }
      }
    );

    // stripe gateway
    app.patch(
      "/checkout-success/:sessionId",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { sessionId } = req.params;
          // console.log("Session ID:", sessionId);

          const session = await stripe.checkout.sessions.retrieve(sessionId);
          // console.log(session);
          const transactionId = session.payment_intent;

          // Check if transaction already exists
          const paymentExist = await paymentsCollection.findOne({
            transactionId,
          });
          if (paymentExist) {
            return res.send({
              message: "Transaction already exists",
              transactionId,
              trackingId: paymentExist.trackingId,
            });
          }

          const trackingId = generateTrackingId();
          const email = session.customer_email;
          if (session.payment_status === "paid") {
            // Update user
            await usersCollection.updateOne(
              { email },
              {
                $set: {
                  isPremium: true,
                  trackingId,
                  purchaseAt: new Date(),
                },
              }
            );
          }

          // Record payment
          const paymentRecord = {
            email,
            amount: session.amount_total / 100,
            currency: session.currency,
            transactionId,
            trackingId,
            purchaseAt: new Date(),
          };

          const resultPayment = await paymentsCollection.insertOne(
            paymentRecord
          );

          res.send({
            success: true,
            trackingId,
            transactionId,
            paymentRecordId: resultPayment.insertedId,
          });

          // console.log("Tracking ID:", trackingId);
        } catch (error) {
          console.error(error);
          res.status(500).send({ success: false, error: error.message });
        }
      }
    );

    // paymet ge
    app.get("/payment", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (query) {
        query.email = email;
      }

      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const payment = await paymentsCollection.findOne({ email }).toArray();
      res.send(payment);
    });

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
