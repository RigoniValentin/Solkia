import express from "express";
import cors from "cors";
import helmet from "helmet";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { rateLimit } from "express-rate-limit";
import fs from "fs";
import http from "http";
import path from "path";
import { ChildProcess, spawn } from "child_process";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/SolkiaDB";
const FRONTEND_DIR = path.join(process.cwd(), "distFront");
const FRONTEND_INTERNAL_PORT = Number(process.env.FRONTEND_INTERNAL_PORT || Number(PORT) + 1);
let frontendProcess: ChildProcess | null = null;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || process.env.NEXTAUTH_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

async function mountFrontend() {
  if (process.env.NODE_ENV !== "production") return;

  const standaloneServerPath = path.join(FRONTEND_DIR, "server.js");

  if (!fs.existsSync(standaloneServerPath)) {
    console.warn(
      `No se encontro el build del frontend en ${FRONTEND_DIR}. Ejecuta npm run build en SolkiaFront.`
    );
    return;
  }

  frontendProcess = spawn(process.execPath, [standaloneServerPath], {
    cwd: FRONTEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(FRONTEND_INTERNAL_PORT),
      HOSTNAME: "127.0.0.1",
      NEXTAUTH_URL:
        process.env.NEXTAUTH_URL ||
        process.env.FRONTEND_URL ||
        `http://localhost:${PORT}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  frontendProcess.on("exit", (code, signal) => {
    console.warn(`Frontend standalone finalizo con code=${code} signal=${signal}`);
  });

  await waitForFrontend(FRONTEND_INTERNAL_PORT);

  app.use("/_next/static", express.static(path.join(FRONTEND_DIR, ".next", "static")));
  app.use(express.static(path.join(FRONTEND_DIR, "public"), { index: false }));
  app.all("*", proxyToFrontend);
}

function waitForFrontend(port: number) {
  const startedAt = Date.now();

  return new Promise<void>((resolve, reject) => {
    const check = () => {
      const req = http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", (error) => {
        if (Date.now() - startedAt > 15000) {
          reject(error);
          return;
        }
        setTimeout(check, 250);
      });

      req.setTimeout(1000, () => req.destroy());
    };

    check();
  });
}

function proxyToFrontend(req: express.Request, res: express.Response) {
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: FRONTEND_INTERNAL_PORT,
      path: req.originalUrl,
      method: req.method,
      headers: {
        ...req.headers,
        host: req.headers.host,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.status(502).json({ message: "Frontend no disponible" });
    }
  });

  req.pipe(proxyReq);
}

// DB connection & server start
async function start() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to SolkiaDB");
    await mountFrontend();

    app.listen(PORT, () => {
      console.log(`🚀 Solkia Backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error("❌ Failed to connect to MongoDB:", error);
    process.exit(1);
  }
}

start();

const shutdown = () => {
  frontendProcess?.kill();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default app;
