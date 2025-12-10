const express = require("express");
const { MongoClient, ServerApiVersion } = require("mongodb");
const app = express();
require("dotenv").config();
const cors = require("cors");
const port = 3000;

// middlewear
app.use(express.json());
app.use(cors());

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
    app.post("/users", async(req, res) => {
        const usersDetail = req.body;
        usersDetail.role = "user";
        usersDetail.createdAt = new Date();
        const email = usersDetail?.email;
        const existingUser = await usersCollection.findOne({email});
        if(existingUser){
            return res.send({message : "User exist"})
        }
        const result = await usersCollection.insertOne(usersDetail);
        res.send(result)
    })

    // users get 
    app.get("/users/:email/role", async(req, res) => {
        const email = req.params.email;
        const query = {email};
        const user = await usersCollection.findOne(query);
        res.send({role : user?.role});
    })









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
