db = db.getSiblingDB('whiteboard'); // Create or switch to 'mydatabase'
db.createCollection('counters'); 
db.createCollection('whiteboard_snapshots'); 
db.createCollection('whiteboard_events');