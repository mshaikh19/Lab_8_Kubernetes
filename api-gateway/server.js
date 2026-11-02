// =============================================================
//   - API Gateway
//  Single entry point that routes /users, /products, /orders
//  to their respective backend microservices.
//
//  Service locations are read from environment variables so
//  no code change is needed when a service URL changes
//  (configuration-based service discovery – Part B).
// =============================================================

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
app.use(cors());

// ─── Service Registry (read from env vars – Part B) ──────────
// These values are injected via docker-compose.yml or cloud
// environment configuration.  Changing a service URL only
// requires updating the environment variable, not this code.
const SERVICE_REGISTRY = {
  user:    process.env.USER_SERVICE_URL    || 'http://user-service:3001',
  product: process.env.PRODUCT_SERVICE_URL || 'http://product-service:3002',
  order:   process.env.ORDER_SERVICE_URL   || 'http://order-service:3003',
};

const PORT = process.env.GATEWAY_PORT || process.env.PORT || 3000;

const requestMetrics = new Map();
let requestDurationSeconds = 0;

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/metrics') return;
    const key = `${req.method}|${req.route?.path || req.path}|${res.statusCode}`;
    requestMetrics.set(key, (requestMetrics.get(key) || 0) + 1);
    requestDurationSeconds += Number(process.hrtime.bigint() - startedAt) / 1e9;
  });
  next();
});

app.get('/metrics', (req, res) => {
  const lines = [
    '# HELP http_requests_total Total HTTP requests handled by the gateway.',
    '# TYPE http_requests_total counter',
  ];
  for (const [key, count] of requestMetrics) {
    const [method, route, status] = key.split('|');
    lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`);
  }
  lines.push(
    '# HELP http_request_duration_seconds_sum Total request duration in seconds.',
    '# TYPE http_request_duration_seconds_sum counter',
    `http_request_duration_seconds_sum ${requestDurationSeconds}`,
  );
  res.type('text/plain').send(`${lines.join('\n')}\n`);
});

// ─── Request Logging (Part A) ─────────────────────────────────
// Custom morgan token that records which backend service
// the request was forwarded to.
morgan.token('target-service', (req) => req.targetService || 'gateway');

app.use(
  morgan(
    ':method :url → :target-service | status=:status | :response-time ms',
    {
      // Stream to stdout so Docker logs capture it
      stream: { write: (msg) => process.stdout.write(msg) },
    }
  )
);

// ─── Health Check (Part A, Step 6) ───────────────────────────
// This endpoint is handled by the gateway itself – no proxying.
app.get('/health', (req, res) => {
  req.targetService = 'gateway';
  res.json({
    gateway: 'UP',
    timestamp: new Date().toISOString(),
    serviceRegistry: SERVICE_REGISTRY,
  });
});

// ─── Proxy Error Handler (Part A – 502/503) ──────────────────
// Called when the target service is unreachable. Returns a
// clear 502 instead of letting the request hang or crash.
function buildErrorHandler(serviceName) {
  return (err, req, res) => {
    console.error(
      `[Gateway] Error forwarding ${req.method} ${req.url} → ${serviceName}: ${err.code || err.message}`
    );
    const status = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' ? 503 : 502;
    res.status(status).json({
      error: status === 503 ? '503 Service Unavailable' : '502 Bad Gateway',
      message: `${serviceName} is unreachable. Please try again later.`,
      targetService: serviceName,
      targetUrl: SERVICE_REGISTRY[serviceName.toLowerCase().split(' ')[0]],
      details: err.message,
    });
  };
}

// ─── Proxy Factory ────────────────────────────────────────────
// pathRewrite restores the full path prefix that Express strips
// when mounting middleware at a sub-path (e.g. app.use('/users')).
// Without it, GET /users/101 would be forwarded as GET /101 to
// the User Service instead of GET /users/101.
// Logging uses req.originalUrl (the full client-facing URL)
// to avoid double-path log entries.
function buildProxy(serviceKey, serviceName, pathPrefix) {
  const target = SERVICE_REGISTRY[serviceKey];
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    // Re-add the mount prefix that Express strips before the middleware sees it
    pathRewrite: (path) => `${pathPrefix}${path}`,
    on: {
      proxyReq: (proxyReq, req) => {
        req.targetService = serviceName;
        console.log(
          `[Gateway] → Forwarding ${req.method} ${req.originalUrl} to ${serviceName} (${target})`
        );
      },
      proxyRes: (proxyRes, req) => {
        console.log(
          `[Gateway] ← ${serviceName} responded with ${proxyRes.statusCode} for ${req.method} ${req.originalUrl}`
        );
      },
      error: buildErrorHandler(serviceName),
    },
  });
}

// ─── Routes (Part A – routing table built from registry) ─────
// /users/*    → User Service    (e.g. GET /users/101)
// /products/* → Product Service (e.g. POST /products)
// /orders/*   → Order Service   (e.g. POST /orders)
app.use('/users',    buildProxy('user',    'User Service',    '/users'));
app.use('/products', buildProxy('product', 'Product Service', '/products'));
app.use('/orders',   buildProxy('order',   'Order Service',   '/orders'));

// ─── 404 for unknown gateway paths ───────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: '404 Not Found',
    message: `No gateway route for ${req.method} ${req.url}`,
    availableRoutes: ['/health', '/users', '/products', '/orders'],
  });
});

// ─── Start Gateway ────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Gateway]  API Gateway running on port ${PORT}`);
  console.log('[Gateway] Service Registry (loaded from environment):');
  console.log(`[Gateway]   User Service    → ${SERVICE_REGISTRY.user}`);
  console.log(`[Gateway]   Product Service → ${SERVICE_REGISTRY.product}`);
  console.log(`[Gateway]   Order Service   → ${SERVICE_REGISTRY.order}`);
  console.log('[Gateway] Routes: /users  /products  /orders  /health');
});
