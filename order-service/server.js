const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.ORDER_SERVICE_PORT || process.env.PORT || 3003;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://order-db:27017/orderdb';

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:3001';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:3002';

// Schema & Model
const orderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  productId: { type: String, required: true },
  quantity: { type: Number, required: true, default: 1 },
  totalAmount: { type: Number, required: true },
  status: { type: String, default: 'CONFIRMED' },
  user: { type: Object },
  product: { type: Object }
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);

// In-memory fallback
let inMemoryOrders = [
  {
    id: '801',
    userId: '101',
    productId: '501',
    quantity: 2,
    totalAmount: 99.98,
    status: 'CONFIRMED',
    user: { id: '101', name: 'Jane Doe', email: 'jane.doe@campus.edu' },
    product: { id: '501', name: 'Laptop Stand', price: 49.99 },
    createdAt: new Date().toISOString()
  }
];

let isMongoConnected = false;

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    isMongoConnected = true;
    console.log(`[Order Service] Connected to MongoDB at ${MONGO_URI}`);
    await seedDB();
  } catch (err) {
    console.warn(`[Order Service] MongoDB connection warning: ${err.message}. Operating with standard persistence store.`);
    isMongoConnected = false;
  }
}

async function seedDB() {
  if (!isMongoConnected) return;
  const count = await Order.countDocuments();
  if (count === 0) {
    await Order.insertMany(inMemoryOrders);
    console.log('[Order Service] Initial database seed completed.');
  }
}

connectDB();

// Endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'Order Service',
    status: 'UP',
    port: PORT,
    userServiceUrl: USER_SERVICE_URL,
    productServiceUrl: PRODUCT_SERVICE_URL,
    dbConnected: isMongoConnected
  });
});

// GET /orders
app.get('/orders', async (req, res) => {
  try {
    if (isMongoConnected) {
      const orders = await Order.find({}, { _id: 0, __v: 0 });
      return res.json(orders);
    }
    res.json(inMemoryOrders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders', details: err.message });
  }
});

// GET /orders/:id
app.get('/orders/:id', async (req, res) => {
  const orderId = req.params.id;
  try {
    if (isMongoConnected) {
      const order = await Order.findOne({ id: orderId }, { _id: 0, __v: 0 });
      if (!order) {
        return res.status(404).json({ error: 'Order not found', orderId });
      }
      return res.json(order);
    }
    const order = inMemoryOrders.find(o => String(o.id) === String(orderId));
    if (!order) {
      return res.status(404).json({ error: 'Order not found', orderId });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order', details: err.message });
  }
});

// POST /orders
app.post('/orders', async (req, res) => {
  const { userId, productId, quantity = 1, id } = req.body;

  if (!userId || !productId) {
    return res.status(400).json({ error: 'userId and productId are required' });
  }

  let userData = null;
  let productData = null;

  // 1. Service-to-Service call: Order Service -> User Service
  try {
    const userRes = await axios.get(`${USER_SERVICE_URL}/users/${userId}`, { timeout: 3000 });
    userData = userRes.data;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({
        error: 'User not found',
        userId,
        details: `User Service verified that user '${userId}' does not exist.`
      });
    }
    return res.status(503).json({
      error: '503 Service Unavailable',
      message: 'User Service is currently unavailable or unreachable.',
      targetUrl: `${USER_SERVICE_URL}/users/${userId}`,
      details: err.message
    });
  }

  // 2. Service-to-Service call: Order Service -> Product Service
  try {
    const productRes = await axios.get(`${PRODUCT_SERVICE_URL}/products/${productId}`, { timeout: 3000 });
    productData = productRes.data;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({
        error: 'Product not found',
        productId,
        details: `Product Service verified that product '${productId}' does not exist.`
      });
    }
    return res.status(503).json({
      error: '503 Service Unavailable',
      message: 'Product Service is currently unavailable or unreachable.',
      targetUrl: `${PRODUCT_SERVICE_URL}/products/${productId}`,
      details: err.message
    });
  }

  // 3. Process Order if dependency calls succeeded
  const qty = Number(quantity) > 0 ? Number(quantity) : 1;
  const price = Number(productData.price) || 0;
  const totalAmount = Number((price * qty).toFixed(2));
  const newId = id ? String(id) : String(Date.now());

  const newOrder = {
    id: newId,
    userId: String(userId),
    productId: String(productId),
    quantity: qty,
    totalAmount,
    status: 'CONFIRMED',
    user: {
      id: userData.id,
      name: userData.name,
      email: userData.email
    },
    product: {
      id: productData.id,
      name: productData.name,
      price: productData.price
    },
    createdAt: new Date().toISOString()
  };

  try {
    if (isMongoConnected) {
      const created = await Order.create(newOrder);
      const orderObj = created.toObject();
      delete orderObj._id;
      delete orderObj.__v;
      return res.status(201).json(orderObj);
    }

    inMemoryOrders.push(newOrder);
    res.status(201).json(newOrder);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save order', details: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Order Service] Running on port ${PORT}`);
  console.log(`[Order Service] Configured User Service URL: ${USER_SERVICE_URL}`);
  console.log(`[Order Service] Configured Product Service URL: ${PRODUCT_SERVICE_URL}`);
});
