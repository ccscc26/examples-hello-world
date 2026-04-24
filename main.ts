// =========================================================
// VLESS Over WebSocket - 硬编码配置版
// 无需设置任何环境变量，直接部署即可
// =========================================================

// ========== 在这里修改你的配置 ==========
const USER_ID = "0032e49d-185b-4ff2-9e55-83e7a3500cb5";
const VALID_PATH = "/d7f3a9b2c5_status";
// =========================================

const TIMEOUT_MS = 30000;
const MAX_CONN = 200;
const HANDSHAKE_TIMEOUT_MS = 5000;
const BUF_SIZE = 65536;
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

// 预编译 UUID
const cleanUuid = USER_ID.replace(/-/g, "");
if (cleanUuid.length !== 32) {
  throw new Error("UUID 格式错误，必须是 32 位十六进制字符（不含连字符）");
}
const EXPECTED_UUID_BYTES = new Uint8Array(
  cleanUuid.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))
);

// 全局 TextDecoder 复用
const DECODER = new TextDecoder();

let activeConn = 0;

function tryAcquireConn(): boolean {
  if (activeConn >= MAX_CONN) return false;
  activeConn++;
  return true;
}

function releaseConn(): void {
  if (activeConn > 0) activeConn--;
}

const FAKE_SERVER_HEADERS = [
  "cloudflare",
  "nginx/1.18.0",
  "openresty/1.19.9.1",
  "Microsoft-IIS/10.0"
];

function generateFakeResponse(): Response {
  const serverHeader = FAKE_SERVER_HEADERS[Math.floor(Math.random() * FAKE_SERVER_HEADERS.length)];
  const isJson = Math.random() > 0.5;
  const body = isJson
    ? `{"code":200,"msg":"success","data":{"ts":${Date.now()}}}`
    : `<!DOCTYPE html><html><body><h1>200 OK</h1></body></html>`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": isJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Server": serverHeader,
      "Date": new Date().toUTCString(),
      "X-Content-Type-Options": "nosniff",
    }
  });
}

function formatIPv6(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  }
  return `[${parts.join(':')}]`;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // 路径校验 & 伪装
  if (url.pathname !== VALID_PATH) {
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    return generateFakeResponse();
  }

  // WebSocket 握手预检
  const upgradeHeader = req.headers.get("upgrade");
  const wsKey = req.headers.get("sec-websocket-key");
  const wsVersion = req.headers.get("sec-websocket-version");

  if (!wsKey || upgradeHeader?.toLowerCase() !== "websocket" || wsVersion !== "13") {
    return generateFakeResponse();
  }

  // 连接数限流
  if (!tryAcquireConn()) {
    return new Response("Service Unavailable", {
      status: 503,
      headers: { "Retry-After": "10" }
    });
  }

  let socket: WebSocket;
  let response: Response;

  try {
    ({ socket, response } = Deno.upgradeWebSocket(req));
  } catch (e) {
    releaseConn();
    console.error("WebSocket upgrade failed:", e);
    return new Response("Internal Server Error", { status: 500 });
  }

  let targetConn: Deno.Conn | null = null;
  let isClosed = false;
  let activityTimer: number | undefined;
  let handshakeTimer: number | undefined;
  let stage: 0 | 1 = 0;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;

    if (activityTimer) clearTimeout(activityTimer);
    if (handshakeTimer) clearTimeout(handshakeTimer);

    try { targetConn?.close(); } catch (_) {}
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "Bye");
      }
    } catch (_) {}

    releaseConn();
  };

  const refreshActivityTimeout = () => {
    if (activityTimer) clearTimeout(activityTimer);
    if (!isClosed) {
      activityTimer = setTimeout(cleanup, TIMEOUT_MS);
    }
  };

  // 握手超时保护
  handshakeTimer = setTimeout(() => {
    if (stage === 0 && !isClosed) {
      cleanup();
    }
  }, HANDSHAKE_TIMEOUT_MS);

  refreshActivityTimeout();

  socket.onmessage = async (event) => {
    if (isClosed) return;

    let data: Uint8Array;
    if (event.data instanceof ArrayBuffer) {
      data = new Uint8Array(event.data);
    } else if (event.data instanceof Blob) {
      try {
        data = new Uint8Array(await event.data.arrayBuffer());
      } catch {
        cleanup();
        return;
      }
    } else {
      data = new Uint8Array(0);
    }

    if (data.length === 0) return;
    refreshActivityTimeout();

    if (stage === 0) {
      // VLESS 握手阶段
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      }

      if (data.length < 22) { cleanup(); return; }
      if (data[0] !== 0) { cleanup(); return; }

      // UUID 校验
      let uuidMatch = true;
      for (let i = 0; i < 16; i++) {
        if (data[1 + i] !== EXPECTED_UUID_BYTES[i]) {
          uuidMatch = false;
          break;
        }
      }
      if (!uuidMatch) { cleanup(); return; }

      const optLength = data[17];
      const cmdIndex = 18 + optLength;
      if (cmdIndex + 4 >= data.length) { cleanup(); return; }

      const cmd = data[cmdIndex];
      if (cmd !== 1) { cleanup(); return; } // 仅支持 TCP

      const portIndex = cmdIndex + 1;
      const targetPort = (data[portIndex] << 8) | data[portIndex + 1];
      if (!ALLOWED_PORTS.has(targetPort)) { cleanup(); return; }

      let addrIndex = portIndex + 2;
      const addrType = data[addrIndex];
      addrIndex++;

      let targetHost = "";
      try {
        if (addrType === 1) { // IPv4
          if (addrIndex + 4 > data.length) throw new Error("Invalid IPv4");
          targetHost = `${data[addrIndex]}.${data[addrIndex + 1]}.${data[addrIndex + 2]}.${data[addrIndex + 3]}`;
          addrIndex += 4;
        } else if (addrType === 2) { // Domain
          if (addrIndex >= data.length) throw new Error("Invalid Domain Len");
          const domainLen = data[addrIndex];
          addrIndex++;
          if (addrIndex + domainLen > data.length) throw new Error("Invalid Domain Data");
          targetHost = DECODER.decode(data.slice(addrIndex, addrIndex + domainLen));
          addrIndex += domainLen;
        } else if (addrType === 3) { // IPv6
          if (addrIndex + 16 > data.length) throw new Error("Invalid IPv6");
          targetHost = formatIPv6(data.slice(addrIndex, addrIndex + 16));
          addrIndex += 16;
        } else {
          throw new Error("Unknown Addr Type");
        }
      } catch (e) {
        console.warn("Address parse error:", e);
        cleanup();
        return;
      }

      // 建立出站连接
      try {
        targetConn = await Deno.connect({ hostname: targetHost, port: targetPort });
      } catch (e) {
        console.warn(`Connect to ${targetHost}:${targetPort} failed:`, e);
        cleanup();
        return;
      }

      // 发送握手成功响应
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(new Uint8Array([0, 0]));
        } else {
          cleanup();
          return;
        }
      } catch (e) {
        cleanup();
        return;
      }

      // 转发剩余数据
      const remainingData = data.slice(addrIndex);
      if (remainingData.length > 0) {
        targetConn.write(remainingData).catch(() => cleanup());
      }

      stage = 1;

      // TCP → WebSocket 转发
      (async () => {
        const buf = new Uint8Array(BUF_SIZE);
        try {
          while (!isClosed && targetConn) {
            const n = await targetConn.read(buf);
            if (n === null) break;
            if (socket.readyState === WebSocket.OPEN) {
              try {
                socket.send(buf.subarray(0, n));
              } catch (e) {
                break;
              }
            } else {
              break;
            }
            refreshActivityTimeout();
          }
        } catch (e) {
          // 忽略读取错误
        } finally {
          cleanup();
        }
      })();

    } else {
      // 数据传输阶段：WebSocket → TCP
      if (targetConn && !isClosed && data.length > 0) {
        targetConn.write(data).catch(() => cleanup());
        refreshActivityTimeout();
      }
    }
  };

  socket.onclose = () => cleanup();
  socket.onerror = (e) => {
    // console.warn("Socket error", e); // 调试时可开启
    cleanup();
  };

  return response;
});
