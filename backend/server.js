require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB
// This forces the local WSL string if the environment variable fails to load
 const mongoURI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/blue_green_db';
//
 mongoose.connect(mongoURI)
//
// Routes
app.use('/api/users', require('./routes/users'));

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Backend API is running' });
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
