/** Temporary public infrastructure probe. No app routes, secrets, uploads or jobs. */
import { createServer } from 'node:http';
import { runRuntimeProbe } from './check-container-runtime.js';
let receipt: unknown = { state: 'checking', applicationAvailable: false };
const port = Number(process.env.PORT ?? '10000');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT.');
const server = createServer((request, response) => {
 response.setHeader('Cache-Control', 'no-store');
 response.setHeader('Content-Type', 'application/json');
 response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
 response.setHeader('X-Content-Type-Options', 'nosniff');
 if (request.method === 'GET' && request.url === '/health') { response.writeHead(200); response.end('{"probeServer":"ready","applicationAvailable":false}'); }
 else if (request.method === 'GET' && request.url === '/') { response.writeHead(200); response.end(JSON.stringify(receipt)); }
 else { response.writeHead(404); response.end('{"error":"Not available"}'); }
});
server.listen(port, '0.0.0.0', () => {
 void runRuntimeProbe(false).then(result => { receipt = { ...result, applicationAvailable: false }; process.stdout.write(JSON.stringify(receipt) + '\n'); });
});
process.on('SIGTERM', () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); });
