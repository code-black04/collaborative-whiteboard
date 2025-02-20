const adapter = require("@socket.io/redis-adapter");
// const redis = require("redis");
const redisSentinel = require("ioredis");
const { MongoClient } = require("mongodb");
const AWS = require("aws-sdk");
const express = require("express");
const crypto = require("crypto");

const app = express();
const http = require("http").createServer(app);
//const io = require("socket.io")(http);
const io = require("socket.io")(http, {
    cors: {
        origin: process.env.BASE_URL,
        methods: ["GET", "POST"],
    },
});
const dotenv = require("dotenv").config();

const PORT = process.env.PORT || 3000;
const MASTER_REDIS_HOST = process.env.MASTER_REDIS_HOST;
const MASTER_REDIS_PORT = process.env.MASTER_REDIS_PORT;
const SLAVE_REDIS_HOST = process.env.SLAVE_REDIS_HOST;
const SLAVE_REDIS_PORT = process.env.SLAVE_REDIS_PORT;
const REDIS_MASTER_NAME = process.env.REDIS_MASTER_NAME;
const SENTINEL_HOSTS_PORT = [
    { host: MASTER_REDIS_HOST, port: MASTER_REDIS_PORT },
    { host: SLAVE_REDIS_HOST, port: SLAVE_REDIS_PORT }
]
const MONGO_URI = process.env.MONGO_URI;
const SCHEDULAR_TIME = process.env.SCHEDULAR_TIME;
const TAKE_SNAPSHOT = process.env.TAKE_SNAPSHOT;
const AWS_REGION = process.env.AWS_REGION || "eu-west-2";

AWS.config.update({ region: AWS_REGION });
const cloudwatch = new AWS.CloudWatch();

console.log("PORT:", PORT);
console.log("MONGO_URI:", MONGO_URI);
console.log("SCHEDULAR_TIME:", SCHEDULAR_TIME);
console.log("TAKE_SNAPSHOT:", TAKE_SNAPSHOT);

async function main() {
    // MongoDB setup
    const mongoClient = new MongoClient(MONGO_URI);
    try {
        await mongoClient.connect();
        console.log("Connected to MongoDB");
    } catch (err) {
        console.error("Failed to connect to MongoDB:", err.message);
        process.exit(1); // MongoDB is critical; exit if it fails
    }

    // Redis setup
    const pubClient = new redisSentinel({
        sentinels: SENTINEL_HOSTS_PORT,
        name: REDIS_MASTER_NAME,
        sentinelRetryStrategy: (times) => Math.min(times * 1000, 60000),
        reconnectOnError: (err) => {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) {
                // Only reconnect when the error contains "READONLY"
                return true;
            }
        },
    });
    const subClient = pubClient.duplicate();

    //callback function for error and to establish connections
    pubClient.on('connect', () => {
        console.log('pubClient Connected to Redis');
    });

    pubClient.on('error', (err) => {
        console.error('pubClient Redis error:', err);
    });

    subClient.on('connect', () => {
        console.log('subClient Connected to Redis');
    });

    subClient.on('error', (err) => {
        console.error('subClient Redis error:', err);
    });

    // Unique Session ID Generator
    function generateSessionId() {
        return crypto.randomBytes(16).toString("hex");
}
    try {
        // await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(adapter.createAdapter(pubClient, subClient));
        console.log("Redis adapter successfully initialized.");
    } catch (err) {
        console.error("Failed to connect Redis adapter:", err);
        process.exit(1);
    }

    const connections = new Set();
    function publishToCloudWatch(connectionsCount) {
        const params = {
            MetricData: [
                {
                    MetricName: "ActiveConnections",
                    Dimensions: [
                        {
                            Name: "ServiceName",
                            Value: "WhiteboardService",
                        },
                    ],
                    Unit: "Count",
                    Value: connectionsCount,
                },
            ],
            Namespace: "Custom/WhiteboardService",
        };

        cloudwatch.putMetricData(params, (err, data) => {
            if (err) {
                console.error("Error publishing metric to CloudWatch:", err.message);
            } else {
                console.log("Metric published to CloudWatch:", JSON.stringify(data));
            }
        });
    }
    //To updateState in mongodb from redis
    if (TAKE_SNAPSHOT === "true") {
        console.log("Set saveEventsToDatabase...");
        setInterval(() => saveEventsToDatabase(pubClient, mongoClient), SCHEDULAR_TIME * 60 * 1000);
        setInterval(() => clearSnapshotFromDatabase(pubClient, mongoClient), 30 * 60 * 1000);
    }

    io.on("connect", (socket) => {
        const sessionId = generateSessionId();
        //connections.add(socket);
        console.log(`${socket.id} connected with sessionId: ${sessionId}`);
        publishToCloudWatch(connections.size);

        // Store session ID in Redis
        pubClient.set(sessionId, socket.id);

        connections.add(socket);
        // Initialize new user and event handlers
        initNewUser(pubClient, socket, mongoClient);
        clearWhiteboard(socket, pubClient, mongoClient);
        emitDrawEvents(socket, pubClient, mongoClient);

        socket.on("disconnect", async () => {
            connections.delete(socket);
            console.log(`${socket.id} has disconnected`);
            publishToCloudWatch(connections.size);

            // Clean up session
            await pubClient.del(sessionId);
        });
    });

    app.use(express.static("public"));

    app.get("/config", (req, res) => {
        res.json({
            baseUrl: process.env.BASE_URL,
        });
    });

    app.get("/health", (req, res) => {
        res.status(200).send("Application is healthy");
    });

    http.listen(PORT, "0.0.0.0", () => console.log(`Server started on port ${PORT}`));
}

main();

async function saveEventsToDatabase(pubClient, mongoClient) {
    const whiteboardEventsCollection = await mongoClient.db("whiteboard").collection("whiteboard_events");
    if (pubClient?.isReady) {
        console.log("saveEventsToDatabase by redis...");
        const reply = await pubClient.lRange('whiteboard_events', 0, -1);
        if (reply.length === 0) {
            console.log("List is empty or does not exist.");
        } else {
            let redisEventsList = []
            if (reply.length > 0) {
                redisEventsList = reply.map((event) => JSON.parse(event));
                console.log(`Loaded ${redisEventsList.length} events from Redis`);
            }
            if (redisEventsList.length == 0) {
                console.log("empty events list received");
            }
            let snapshot = []
            for (let i = 0; i < redisEventsList.length; i += 2) {
                const eventName = redisEventsList[i];
                const eventData = redisEventsList[i + 1];
                //console.log("emit populateMongoDB ", eventName, eventData);
                //await populateMongoDB(mongoClient, eventName, eventData);
                snapshot[i / 2] = { name: eventName, data: eventData };
            }
            if (snapshot.length > 0) {
                console.log("new snapshot length:", snapshot.length);
                await addSnapshot(mongoClient, snapshot);
            }
            pubClient.del("whiteboard_events");
        }
    } else {
        console.log("redis down taking snapshot from mongo...");
        const results = await whiteboardEventsCollection.find().sort({ _id: 1 }).toArray();
        //console.log("results size ", results);
        let snapshot = []
        for (let i = 0; i < results.length; i += 1) {
            const event = results[i];
            snapshot[i] = { name: event.name, data: event.data };
        }
        if (snapshot.length > 0) {
            console.log("emit addSnapshot ", snapshot.length);
            await addSnapshot(mongoClient, snapshot);
        }
    }
    // Drop the collection
    if (whiteboardEventsCollection) {
        const result = await whiteboardEventsCollection.deleteMany({});
        if (result) {
            console.log("Collection whiteboard_events dropped successfully.");
        } else {
            console.log("Collection whiteboard_events could not be dropped.");
        }
    }

}

async function clearSnapshotFromDatabase(pubClient, mongoClient) {
    const whiteboardDb = await mongoClient.db("whiteboard");
    const nextId = await getNextSequence(whiteboardDb, "whiteboard_snapshots");
    const whiteboardSnapshotCollection = await whiteboardDb.collection("whiteboard_snapshots");

    // Count total documents
    const totalDocs = await whiteboardSnapshotCollection.countDocuments();

    // If more than 5 documents, delete the excess
    if (totalDocs > 1) {
        const excessDocs = totalDocs - 1;

        // Find the excess documents (oldest ones)
        const oldDocs = await whiteboardSnapshotCollection.find()
            .sort({ _id: 1 }) // Ascending order by _id (oldest first)
            .limit(excessDocs)
            .toArray();

        // Delete each of the excess documents
        for (const doc of oldDocs) {
            await whiteboardSnapshotCollection.deleteOne({ _id: doc._id });
        }
        console.log(`${excessDocs} old documents deleted.`);
    } else {
        console.log("No excess documents to delete.");
    }
}


function clearWhiteboard(socket, pubClient, mongoClient) {
    ["clear"].forEach(
        (name) => socket.on(name, async (data) => {
            if (name === "clear") {
                try {
                    if (pubClient?.isReady) pubClient.del("whiteboard_events");
                    if (mongoClient) {
                        const whiteboardDb = await mongoClient.db("whiteboard");
                        const whiteboardEventsCollection = await whiteboardDb.collection("whiteboard_events");
                        const result = await whiteboardEventsCollection.deleteMany({});
                        console.log(`Cleared ${result.deletedCount} documents from the whiteboard_events collection.`);
                        const snapshotCollection = await whiteboardDb.collection("whiteboard_snapshots");
                        const result1 = await snapshotCollection.deleteMany({});
                        console.log(`Cleared ${result1.deletedCount} documents from the whiteboard_snapshots collection.`);
                    }
                    io.emit("clear");
                    console.log("Whiteboard cleared");
                } catch (err) {
                    console.error("Failed to clear state:", err.message);
                }
            }

        })
    );
}

async function emitDrawEvents(socket, pubClient, mongoClient) {
    ["drawText", "drawLine", "drawCircle", "drawRect"].forEach(
        (name) => socket.on(name, async (data) => {
            if (pubClient?.isReady) {
                console.log("emitDrawEvents:isReady is up........");
            } else {
                console.log("emitDrawEvents:isReady is down........");
            }

            if (pubClient?.isReady) {
                pubClient.rPush("whiteboard_events", JSON.stringify(name));
                pubClient.rPush("whiteboard_events", JSON.stringify(data));
            } else {
                console.log("redis is down........");
                if (mongoClient) {
                    await populateMongoDB(mongoClient, name, data);
                }
            }
            socket.broadcast.emit(name, data);
        })
    );
}


async function populateMongoDB(mongoClient, name, data) {
    const whiteboardDb = await mongoClient.db("whiteboard");
    const nextId = await getNextSequence(whiteboardDb, "whiteboard_events");
    const whiteboardEventsCollection = await whiteboardDb.collection("whiteboard_events");
    await whiteboardEventsCollection.insertOne({
        _id: nextId,
        timestamp: new Date(),
        name: name,
        data: data
    }, (error) => {
        console.log("Error while populateMongoDB....")
        if (error) console.log(error);
    });
}

async function addSnapshot(mongoClient, snapshot) {
    const whiteboardDb = await mongoClient.db("whiteboard");
    const nextId = await getNextSequence(whiteboardDb, "whiteboard_snapshots");
    const whiteboardSnapshotCollection = await whiteboardDb.collection("whiteboard_snapshots");
    await whiteboardSnapshotCollection.insertOne({
        _id: nextId,
        timestamp: new Date(),
        event_list: snapshot
    }, (error) => {
        console.log("Error while addSnapshot....")
        if (error) console.log(error);
    });
}

async function initNewUser(pubClient, socket, mongoClient) {
    console.log("initNewUser...");
    try {

        if (pubClient?.isReady) {
            console.log("initNewUser:isReady is up........");
        } else {
            console.log("initNewUser:isReady is down........");
        }

        if (mongoClient) {

            console.log("init by mongoclient...load last 3 snapshots");
            const snapshot = await mongoClient.db("whiteboard").collection("whiteboard_snapshots");
            const eventList = await snapshot.find().sort({ _id: -1 }).toArray();
            for (const snap of eventList) {
                console.log("Mongo snap emit ", snap.event_list.length);
                for (const event of snap.event_list) {
                    socket.emit(event.name, event.data);
                }
            }

            console.log("init by mongoclient...load last from whiteboard events, incase redis down..");
            const whiteboardEventsCollection = await mongoClient.db("whiteboard").collection("whiteboard_events");
            const results = await whiteboardEventsCollection.find().sort({ _id: 1 }).toArray();
            console.log("results size ", results.length);
            for (const event of results) {
                socket.emit(event.name, event.data);
            }
        }

        if (pubClient?.isReady) {
            console.log("init by redis...");
            const reply = await pubClient.lRange('whiteboard_events', 0, -1);
            console.log("get Listt.");
            if (reply.length === 0) {
                console.log("List is empty or does not exist.");
            } else {
                let redisEventsList = []
                if (reply.length > 0) {
                    redisEventsList = reply.map((event) => JSON.parse(event));
                    console.log(`Loaded ${redisEventsList.length} events from Redis`);
                }
                if (redisEventsList.length == 0) {
                    console.log("empty events list received");
                }

                for (let i = 0; i < redisEventsList.length; i += 2) {
                    const eventName = redisEventsList[i];
                    const eventData = redisEventsList[i + 1];
                    socket.emit(eventName, eventData);
                }
            }
        }
    } catch (err) {
        if (err) {
            console.error('Error retrieving list from redis', err);
            return;
        }
    }
}

async function getNextSequence(db, name) {
    const countersCollection = db.collection("counters");
    const result = await countersCollection.findOneAndUpdate(
        { _id: name },
        { $inc: { sequence_value: 1 } },
        { returnDocument: "after", upsert: true }
    );
    console.log("get next seq ", result.value.sequence_value);
    return result.value.sequence_value;
}
