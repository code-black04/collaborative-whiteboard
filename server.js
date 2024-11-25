const adapter = require("@socket.io/redis-adapter");
const redis = require("redis");
const { MongoClient } = require("mongodb");

const express = require("express");
const app = express();
const path = require("path");
const http = require("http").createServer(app);
const io = require("socket.io")(http);
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const MONGO_URI = process.env.MONGO_URI;
const SCHEDULAR_TIME = process.env.SCHEDULAR_TIME;

console.log("REDIS_HOST:", REDIS_HOST);
console.log("REDIS_PORT:", REDIS_PORT);
console.log("PORT:", PORT);
console.log("MONGO_URI:", MONGO_URI);
console.log("SCHEDULAR_TIME:", SCHEDULAR_TIME);

async function main() {

    //mongo-db setup
    const mongoClient = new MongoClient(MONGO_URI);
    try {
        await mongoClient.connect();
        console.log("Connected to MongoDB");
    } catch (err) {
        console.error("Failed to connect to MongoDB:", err.message);
        process.exit(1); // MongoDB is critical; exit if it fails
    }

    //redis setup
    const pubClient = redis.createClient({
        socket: {
            host: REDIS_HOST,
            port: REDIS_PORT,
            connectTimeout: 5000,
            reconnectStrategy: (retries) => {
                if (retries > 5) {
                    //return new Error('Too many retries');
                }
                return 1000; // Retry every 1 second
            }
        }
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

    // Pub/Sub initilaizer for each user
    try {
        await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(adapter.createAdapter(pubClient, subClient));
        console.log('Pub and Sub clients connected, adapter set up successfully.');
    } catch (err) {
        console.error('Error connecting Pub/Sub clients or setting up adapter:', err);
        await Promise.allSettled([pubClient.disconnect(), subClient.disconnect()]);
    }

    const connections = new Set();

    //To updateState in mongodb from redis
    setInterval(() => saveEventsToDatabase(pubClient, mongoClient), SCHEDULAR_TIME * 60 * 1000);

    //New socket connection
    io.on("connect", (socket) => {
        connections.add(socket);
        console.log(`${socket.id} has connected`);
        console.log("Connected: " + connections.size);

        initNewUser(pubClient, socket, mongoClient);

        clearWhiteboard(socket, pubClient, mongoClient);

        emitDrawEvents(socket, pubClient, mongoClient);

        socket.on("disconnect", function () {
            connections.delete(socket);
            console.log(`${socket.id} has disconnected`);
            console.log("Connected: " + connections.size);

        });
    });

    app.use(express.static("public"));

    var REDIS_PORT = process.env.REDIS_PORT;
    http.listen(PORT, () => console.log(`REdis server started on port ${PORT}`));
}

main();

async function saveEventsToDatabase(pubClient, mongoClient) {
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

            for (let i = 0; i < redisEventsList.length; i += 2) {
                const eventName = redisEventsList[i];
                const eventData = redisEventsList[i + 1];
                console.log("emit populateMongoDB ", eventName, eventData);
                await populateMongoDB(mongoClient, eventName, eventData);
            }
            pubClient.del("whiteboard_events");
        }
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
                        console.log(`Cleared ${result.deletedCount} documents from the collection.`);
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
                pubClient.get("sdfsdf");
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

async function initNewUser(pubClient, socket, mongoClient) {
    console.log("initNewUser...");
    try {

        if (pubClient?.isReady) {
            console.log("initNewUser:isReady is up........");
        } else {
            console.log("initNewUser:isReady is down........");
        }

        if (mongoClient) {
            console.log("init by mongoclient...");
            const whiteboardEventsCollection = await mongoClient.db("whiteboard").collection("whiteboard_events");
            const results = await whiteboardEventsCollection.find().sort({ _id: 1 }).toArray();
            //console.log("results size ", results);
            for (const event of results) {
                console.log("Mongo event emit ", event.name);
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
                    // console.log("emit event ", eventName, eventData);
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