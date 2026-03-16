const startTime = Date.now();

export function GET(): Response {
  return Response.json({
    ok: true,
    version: "0.1.0",
    uptime_ms: Date.now() - startTime,
  });
}
