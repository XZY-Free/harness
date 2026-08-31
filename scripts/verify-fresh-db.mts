import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import mysql from "mysql2/promise";

const ROOT = process.cwd();
const EXPECTED_TABLES = JSON.parse(
  readFileSync(
    resolve(ROOT, "docs/implementation/topic-01-loop-schema/07-final-schema-manifest.json"),
    "utf8",
  ),
) as { tableCount: number; tables: string[] };

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function run(label: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    console.log(`[fresh-db] ${label}`);
    const child = spawn("pnpm", [...args], { cwd: ROOT, env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${label} 失败，exit=${code}`));
    });
  });
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("无法分配 Fresh DB boot 端口"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForBoot(origin: string, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next.js 启动前退出，exit=${child.exitCode}`);
    try {
      const response = await fetch(origin, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return response.status;
    } catch {
      // 端口尚未就绪，在 deadline 内继续等待。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("Next.js Fresh DB boot 120s 内未就绪");
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveStop();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
}

async function main(): Promise<void> {
  process.env.TESTCONTAINERS_RYUK_DISABLED = "true";
  const { MySqlContainer } = await import("@testcontainers/mysql");
  const distDir = ".next-fresh-db";
  let app: ChildProcess | null = null;
  console.log("[fresh-db] 启动空 MySQL 8");
  const container = await new MySqlContainer("mysql:8.0")
    .withDatabase("snow_fresh")
    .withRootPassword("test")
    .start();

  try {
    const connectionString = container.getConnectionUri();
    const env = {
      ...process.env,
      ...loadEnvFile(resolve(ROOT, ".env.test")),
      APP_ENV: "test",
      DATABASE_URL: connectionString,
      LLM_API_KEY: "fresh-db-test-key",
      SNOWHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET: "fresh-db-test-workload-signing-secret-0123456789",
      SNOW_DIST_DIR: distDir,
    };

    await run("migrate", ["db:migrate"], env);
    await run("seed", ["db:seed"], env);

    const connection = await mysql.createConnection(connectionString);
    try {
      const [tableRows] = await connection.query<Record<string, string>[]>("SHOW TABLES");
      const tables = tableRows
        .map((row) => String(Object.values(row)[0]))
        .filter((name) => !name.startsWith("__"))
        .sort();
      if (JSON.stringify(tables) !== JSON.stringify(EXPECTED_TABLES.tables)) {
        throw new Error(`Fresh DB table manifest 不一致：actual=${tables.length}`);
      }
      const [seedRows] = await connection.query<mysql.RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM Tenant) AS tenants, " +
          "(SELECT COUNT(*) FROM UserIdentity) AS identities, " +
          "(SELECT COUNT(*) FROM RoleActionBinding) AS grants, " +
          "(SELECT COUNT(*) FROM Agent) AS agents",
      );
      const seed = seedRows[0];
      if (
        !seed ||
        seed.tenants !== 1 ||
        seed.identities !== 1 ||
        seed.grants <= 0 ||
        seed.agents !== 0
      ) {
        throw new Error(`Fresh DB seed 结果非法：${JSON.stringify(seed ?? {})}`);
      }
      console.log(
        `[fresh-db] manifest=${tables.length}, tenant=${seed.tenants}, identity=${seed.identities}, grants=${seed.grants}, agent=${seed.agents}`,
      );
    } finally {
      await connection.end();
    }

    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    console.log(`[fresh-db] boot ${origin}`);
    app = spawn("pnpm", ["exec", "next", "dev", "--port", String(port)], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    app.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    app.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    const status = await waitForBoot(origin, app);
    console.log(`[fresh-db] boot HTTP ${status}`);
    console.log("[fresh-db] PASS migrate -> seed -> boot");
  } finally {
    await stopChild(app);
    await container.stop();
    rmSync(resolve(ROOT, distDir), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[fresh-db] FAIL", error);
  process.exit(1);
});
