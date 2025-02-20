# whiteboard


# Redis Stack and Node.js Application Setup

This guide provides steps to set up and run Redis Stack using Docker and a Node.js application.

---

## Prerequisites

Before proceeding, ensure you have the following installed on your system:

1. **Docker**:
   - Install Docker from [Docker's official website](https://www.docker.com/).
   - Verify the installation by running:
     ```bash
     docker --version
     ```

2. **Node.js**:
   - Install Node.js and npm from [Node.js official website](https://nodejs.org/).
   - Verify the installation by running:
     ```bash
     node --version
     npm --version
     ```

3. **Redis CLI** (Optional for monitoring commands):
   - For installation instructions, visit [Redis official website](https://redis.io/).
   - Verify the installation by running:
     ```bash
     redis-cli --version
     ```

---

## Steps to Run

### Step 1: Start Redis Stack

Run the following command to start Redis Stack in detached mode using Docker:

```bash
docker run -d --name redis-stack -p 6379:6379 -p 8001:8001 redis/redis-stack:latest
```

Run the following to verify the redis-stack container is running:
```bash
docker ps
```

### Step 2: Connect to Redis CLI

Once the Redis Stack container is running, connect to it using Redis CLI:
```bash
redis-cli
```

### Step 3: Monitor Redis Commands

In Redis CLI, run the following command to monitor all commands processed by the Redis server:
```bash
monitor
```

### Step 4: List All Keys in Redis

In Redis CLI, you can list all keys stored in the database using:
```
keys *
```

```bash
LRANGE whiteboard_events 0 -1 
```

### Step 5: Install Node.js Application Dependencies and Start the Application

Navigate to your Node.js project directory and run the following commands:

```bash
npm install && clear && npm start
```

