import { applyCors, send } from '../lib/http.js';
export default function handler(req, res) {
  if (applyCors(req, res)) return;
  send(res, 200, { service: 'lonekeem-studios-api', endpoints: ['GET /api/health', 'GET /api/models', 'GET /api/me', 'POST /api/generate', 'GET /api/status?id=', 'POST /api/claim-daily', 'POST /api/fal-webhook'] });
}
