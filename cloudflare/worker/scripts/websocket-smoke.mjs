const origin = process.env.WORKER_ORIGIN;
const username = process.env.SMOKE_USERNAME;
const password = process.env.SMOKE_PASSWORD;
const deviceId = process.env.SMOKE_DEVICE_ID ?? "ESP32_001";

if (!origin || !username || !password) {
  console.error("WEBSOCKET FAIL missing process environment");
  process.exit(2);
}

const timeout = setTimeout(() => {
  console.error("WEBSOCKET FAIL timeout");
  process.exit(1);
}, 15_000);

try {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) throw new Error(`login status ${response.status}`);
  const { accessToken } = await response.json();
  if (typeof accessToken !== "string") throw new Error("login returned no token");

  const websocketOrigin = origin.replace(/^http/, "ws");
  const socket = new WebSocket(
    `${websocketOrigin}/realtime?deviceId=${encodeURIComponent(deviceId)}`,
    ["iot-fire", `jwt.${accessToken}`]
  );
  socket.onopen = () => socket.send("ping");
  socket.onmessage = event => {
    if (event.data !== "pong") return;
    clearTimeout(timeout);
    console.log(`WEBSOCKET PASS protocol=${socket.protocol} auth=PASS device=${deviceId} ping=PASS`);
    socket.close(1000, "done");
  };
  socket.onerror = () => {
    throw new Error("websocket error");
  };
} catch (error) {
  clearTimeout(timeout);
  console.error(`WEBSOCKET FAIL ${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
}
