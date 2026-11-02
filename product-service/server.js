const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PRODUCT_SERVICE_PORT || process.env.PORT || 3002;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://product-db:27017/productdb';

// Schema & Model
const productSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, default: 'General' },
  stock: { type: Number, default: 50 }
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

// In-Memory Fallback Cache for fast initial testing & resilience
let inMemoryProducts = [
  { id: '501', name: 'Laptop Stand', price: 49.99, category: 'Electronics', stock: 25 },
  { id: '502', name: 'Ergonomic Mouse', price: 29.99, category: 'Electronics', stock: 40 },
  { id: '503', name: 'Mechanical Keyboard', price: 89.99, category: 'Electronics', stock: 15 }
];

let isMongoConnected = false;

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    isMongoConnected = true;
    console.log(`[Product Service] Connected to MongoDB at ${MONGO_URI}`);
    await seedDB();
  } catch (err) {
    console.warn(`[Product Service] MongoDB connection warning: ${err.message}. Operating with standard persistence store.`);
    isMongoConnected = false;
  }
}

async function seedDB() {
  if (!isMongoConnected) return;
  const count = await Product.countDocuments();
  if (count === 0) {
    await Product.insertMany(inMemoryProducts);
    console.log('[Product Service] Initial database seed completed.');
  }
}

connectDB();

// Endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'Product Service',
    status: 'UP',
    port: PORT,
    dbConnected: isMongoConnected
  });
});

// GET /products
app.get('/products', async (req, res) => {
  try {
    if (isMongoConnected) {
      const products = await Product.find({}, { _id: 0, __v: 0 });
      return res.json(products);
    }
    res.json(inMemoryProducts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products', details: err.message });
  }
});

// GET /products/:id
app.get('/products/:id', async (req, res) => {
  const productId = req.params.id;
  try {
    if (isMongoConnected) {
      const product = await Product.findOne({ id: productId }, { _id: 0, __v: 0 });
      if (!product) {
        return res.status(404).json({ error: 'Product not found', productId });
      }
      return res.json(product);
    }
    const product = inMemoryProducts.find(p => String(p.id) === String(productId));
    if (!product) {
      return res.status(404).json({ error: 'Product not found', productId });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product', details: err.message });
  }
});

// POST /products
app.post('/products', async (req, res) => {
  try {
    const { name, price, category, stock, id } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Name and Price are required' });
    }

    const newId = id ? String(id) : String(Date.now());
    const newProduct = {
      id: newId,
      name,
      price: Number(price),
      category: category || 'General',
      stock: stock !== undefined ? Number(stock) : 10
    };

    if (isMongoConnected) {
      const created = await Product.create(newProduct);
      const prodObj = created.toObject();
      delete prodObj._id;
      delete prodObj.__v;
      return res.status(201).json(prodObj);
    }

    inMemoryProducts.push(newProduct);
    res.status(201).json(newProduct);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create product', details: err.message });
  }
});

// PUT /products/:id
app.put('/products/:id', async (req, res) => {
  const productId = req.params.id;
  try {
    const { name, price, category, stock } = req.body;
    if (isMongoConnected) {
      const updated = await Product.findOneAndUpdate(
        { id: productId },
        { $set: {
            ...(name && { name }),
            ...(price !== undefined && { price: Number(price) }),
            ...(category && { category }),
            ...(stock !== undefined && { stock: Number(stock) })
          }
        },
        { new: true, fields: { _id: 0, __v: 0 } }
      );
      if (!updated) {
        return res.status(404).json({ error: 'Product not found', productId });
      }
      return res.json(updated);
    }

    const index = inMemoryProducts.findIndex(p => String(p.id) === String(productId));
    if (index === -1) {
      return res.status(404).json({ error: 'Product not found', productId });
    }
    if (name) inMemoryProducts[index].name = name;
    if (price !== undefined) inMemoryProducts[index].price = Number(price);
    if (category) inMemoryProducts[index].category = category;
    if (stock !== undefined) inMemoryProducts[index].stock = Number(stock);
    res.json(inMemoryProducts[index]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product', details: err.message });
  }
});

// DELETE /products/:id
app.delete('/products/:id', async (req, res) => {
  const productId = req.params.id;
  try {
    if (isMongoConnected) {
      const result = await Product.deleteOne({ id: productId });
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'Product not found', productId });
      }
      return res.json({ message: 'Product deleted successfully', productId });
    }

    const index = inMemoryProducts.findIndex(p => String(p.id) === String(productId));
    if (index === -1) {
      return res.status(404).json({ error: 'Product not found', productId });
    }
    inMemoryProducts.splice(index, 1);
    res.json({ message: 'Product deleted successfully', productId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product', details: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Product Service] Running on port ${PORT}`);
});
