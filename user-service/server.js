const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.USER_SERVICE_PORT || process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://user-db:27017/userdb';

// Schema & Model
const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  role: { type: String, default: 'Student' }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// In-Memory Fallback Cache for quick response & offline test resilience
let inMemoryUsers = [
  { id: '101', name: 'Jane Doe', email: 'jane.doe@campus.edu', role: 'Student' },
  { id: '102', name: 'Alex Smith', email: 'alex.smith@campus.edu', role: 'Instructor' },
  { id: '103', name: 'Sam Green', email: 'sam.green@campus.edu', role: 'Student' }
];

let isMongoConnected = false;

// Connect to MongoDB
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    isMongoConnected = true;
    console.log(`[User Service] Connected to MongoDB at ${MONGO_URI}`);
    await seedDB();
  } catch (err) {
    console.warn(`[User Service] MongoDB connection warning: ${err.message}. Operating with standard persistence store.`);
    isMongoConnected = false;
  }
}

async function seedDB() {
  if (!isMongoConnected) return;
  const count = await User.countDocuments();
  if (count === 0) {
    await User.insertMany(inMemoryUsers);
    console.log('[User Service] Initial database seed completed.');
  }
}

connectDB();

// Endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'User Service',
    status: 'UP',
    port: PORT,
    dbConnected: isMongoConnected
  });
});

// GET /users
app.get('/users', async (req, res) => {
  try {
    if (isMongoConnected) {
      const users = await User.find({}, { _id: 0, __v: 0 });
      return res.json(users);
    }
    res.json(inMemoryUsers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users', details: err.message });
  }
});

// GET /users/:id
app.get('/users/:id', async (req, res) => {
  const userId = req.params.id;
  try {
    if (isMongoConnected) {
      const user = await User.findOne({ id: userId }, { _id: 0, __v: 0 });
      if (!user) {
        return res.status(404).json({ error: 'User not found', userId });
      }
      return res.json(user);
    }
    const user = inMemoryUsers.find(u => String(u.id) === String(userId));
    if (!user) {
      return res.status(404).json({ error: 'User not found', userId });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user', details: err.message });
  }
});

// POST /users
app.post('/users', async (req, res) => {
  try {
    const { name, email, role, id } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and Email are required' });
    }
    
    const newId = id ? String(id) : String(Date.now());
    const newUser = { id: newId, name, email, role: role || 'Student' };

    if (isMongoConnected) {
      const created = await User.create(newUser);
      const userObj = created.toObject();
      delete userObj._id;
      delete userObj.__v;
      return res.status(201).json(userObj);
    }

    inMemoryUsers.push(newUser);
    res.status(201).json(newUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user', details: err.message });
  }
});

// PUT /users/:id
app.put('/users/:id', async (req, res) => {
  const userId = req.params.id;
  try {
    const { name, email, role } = req.body;
    if (isMongoConnected) {
      const updated = await User.findOneAndUpdate(
        { id: userId },
        { $set: { ...(name && { name }), ...(email && { email }), ...(role && { role }) } },
        { new: true, fields: { _id: 0, __v: 0 } }
      );
      if (!updated) {
        return res.status(404).json({ error: 'User not found', userId });
      }
      return res.json(updated);
    }

    const index = inMemoryUsers.findIndex(u => String(u.id) === String(userId));
    if (index === -1) {
      return res.status(404).json({ error: 'User not found', userId });
    }
    if (name) inMemoryUsers[index].name = name;
    if (email) inMemoryUsers[index].email = email;
    if (role) inMemoryUsers[index].role = role;
    res.json(inMemoryUsers[index]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user', details: err.message });
  }
});

// DELETE /users/:id
app.delete('/users/:id', async (req, res) => {
  const userId = req.params.id;
  try {
    if (isMongoConnected) {
      const result = await User.deleteOne({ id: userId });
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'User not found', userId });
      }
      return res.json({ message: 'User deleted successfully', userId });
    }

    const index = inMemoryUsers.findIndex(u => String(u.id) === String(userId));
    if (index === -1) {
      return res.status(404).json({ error: 'User not found', userId });
    }
    inMemoryUsers.splice(index, 1);
    res.json({ message: 'User deleted successfully', userId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user', details: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[User Service] Running on port ${PORT}`);
});
