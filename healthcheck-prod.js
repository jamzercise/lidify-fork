// Production health check - hits /api/health so the backend is checked (Next.js proxies to 3006).
// If the backend is hung, the proxy will fail and the container can be restarted.
const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3030,
  path: '/api/health',
  method: 'GET',
  timeout: 10000,
};

const req = http.request(options, (res) => {
  process.exit(res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1);
});

req.on('error', () => process.exit(1));
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});

req.end();
