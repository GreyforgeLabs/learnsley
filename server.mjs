import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const workDir = path.join(rootDir, "workspaces");
const runsDir = path.join(workDir, "runs");
const progressPath = process.env.LEARNSLEY_PROGRESS || path.join(workDir, "progress.json");
const trialsPath = path.join(rootDir, "content", "trials.json");
const sleyBin = process.env.SLEY_BIN || "<sley-repo>/target/debug/sley";
const host = process.env.LEARNSLEY_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "4179", 10);

const maxBodyBytes = 64 * 1024;
const maxCodeBytes = 24 * 1024;
const commandTimeoutMs = 5000;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"]
]);

await mkdir(runsDir, { recursive: true });

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function textResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {"content-type": contentType});
  res.end(body);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function loadTrials() {
  const trials = await readJson(trialsPath, []);
  return trials.map((trial, index) => ({ ...trial, order: index + 1 }));
}

function publicTrial(trial) {
  const { seal, ...safeTrial } = trial;
  return safeTrial;
}

function baseProgress() {
  return {
    schema: "learnsley.progress.v0",
    xp: 0,
    shards: 0,
    level: 1,
    dailyPulse: 0,
    activeDays: [],
    cleanSealChain: 0,
    proofArmor: 2,
    completed: {},
    attempts: {},
    updatedAt: null
  };
}

async function loadProgress() {
  try {
    const progress = await readJson(progressPath, baseProgress());
    return { ...baseProgress(), ...progress };
  } catch (error) {
    if (error instanceof SyntaxError) {
      const corruptPath = path.join(
        path.dirname(progressPath),
        `${path.basename(progressPath)}.corrupt.${Date.now()}.${randomUUID()}`
      );
      await rename(progressPath, corruptPath).catch(() => {});
      return baseProgress();
    }
    throw error;
  }
}

async function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  const tmp = path.join(
    path.dirname(progressPath),
    `${path.basename(progressPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  );
  await mkdir(path.dirname(progressPath), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  await rename(tmp, progressPath);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function updateDailyPulse(progress) {
  const today = todayKey();
  if (!progress.activeDays.includes(today)) {
    progress.activeDays.push(today);
    progress.activeDays.sort();
  }

  let pulse = 0;
  const active = new Set(progress.activeDays);
  const cursor = new Date(`${today}T00:00:00.000Z`);
  while (active.has(cursor.toISOString().slice(0, 10))) {
    pulse += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  progress.dailyPulse = pulse;
}

function updateLevel(progress) {
  progress.level = Math.max(1, Math.floor(progress.xp / 100) + 1);
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw Object.assign(new Error("request body is too large"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function findTrial(trials, trialId) {
  return trials.find((trial) => trial.id === trialId);
}

function validateSubmission(trial, code) {
  if (!trial) {
    throw Object.assign(new Error("unknown trial"), { statusCode: 404 });
  }
  if (typeof code !== "string") {
    throw Object.assign(new Error("code must be a string"), { statusCode: 400 });
  }
  if (Buffer.byteLength(code, "utf8") > maxCodeBytes) {
    throw Object.assign(new Error("submission is too large"), { statusCode: 413 });
  }
}

async function writeRunFile(code) {
  const runId = randomUUID();
  const runDir = path.join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const sourcePath = path.join(runDir, "main.sley");
  await writeFile(sourcePath, code, "utf8");
  return { runId, runDir, sourcePath };
}

function runSley(args) {
  return new Promise((resolve) => {
    const child = spawn(sleyBin, args, {
      cwd: rootDir,
      shell: false,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, commandTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 128 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 128 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

function parseJsonOutput(commandResult) {
  try {
    return JSON.parse(commandResult.stdout);
  } catch {
    return null;
  }
}

async function compileAndRun(code) {
  const { sourcePath } = await writeRunFile(code);
  const check = await runSley(["check", "--json", sourcePath]);
  const checkJson = parseJsonOutput(check);
  if (!check.ok) {
    return {
      ok: false,
      phase: "check",
      check,
      checkJson,
      output: null,
      graphJson: null,
      sealJson: null
    };
  }

  const run = await runSley(["run", "--json", sourcePath]);
  const output = parseJsonOutput(run);
  const graph = await runSley(["graph", "--json", sourcePath]);
  const seal = await runSley(["seal", "--json", sourcePath]);

  return {
    ok: run.ok,
    phase: run.ok ? "run" : "run",
    check,
    checkJson,
    run,
    output,
    graphJson: parseJsonOutput(graph),
    graphRaw: graph.stdout || graph.stderr,
    sealJson: parseJsonOutput(seal),
    sealRaw: seal.stdout || seal.stderr
  };
}

function valuesEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function keywordSeal(code, seal) {
  const text = code.toLowerCase();
  const missing = [];
  for (const group of seal.required || []) {
    const ok = group.some((term) => text.includes(term.toLowerCase()));
    if (!ok) {
      missing.push(group);
    }
  }
  return {
    ok: missing.length === 0,
    missing
  };
}

async function runTrial(trial, code) {
  if (trial.mode === "explanation") {
    return {
      ok: true,
      phase: "explanation",
      explanation: code,
      checkJson: null,
      output: { kind: "Explanation", value: code },
      graphJson: null,
      sealJson: null
    };
  }
  return compileAndRun(code);
}

async function sealTrial(trial, code) {
  if (trial.seal.kind === "keywords") {
    const result = keywordSeal(code, trial.seal);
    return {
      passed: result.ok,
      reason: result.ok ? "Answer accepted." : "Answer is missing required concepts.",
      detail: result,
      run: await runTrial(trial, code)
    };
  }

  const run = await compileAndRun(code);
  if (!run.ok) {
    return {
      passed: false,
      reason: `Program failed during ${run.phase}.`,
      detail: null,
      run
    };
  }

  const passed = valuesEqual(run.output, trial.seal.expected);
  return {
    passed,
    reason: passed ? "Seal accepted." : "Runtime output did not match the seal.",
    detail: {
      expected: trial.seal.expected,
      actual: run.output
    },
    run
  };
}

function applySealProgress(progress, trial, passed) {
  const now = new Date().toISOString();
  const attempt = progress.attempts[trial.id] || { runs: 0, seals: 0, failedSeals: 0 };
  attempt.seals += 1;
  attempt.lastSealAt = now;
  progress.attempts[trial.id] = attempt;
  updateDailyPulse(progress);

  const awards = [];
  if (passed) {
    const alreadyCompleted = Boolean(progress.completed[trial.id]);
    progress.cleanSealChain += 1;
    if (!alreadyCompleted) {
      const xp = trial.rewards?.xp || 0;
      const shards = trial.rewards?.shards || 0;
      progress.xp += xp;
      progress.shards += shards;
      progress.completed[trial.id] = { completedAt: now, xp, shards };
      awards.push(`+${xp} XP`, `+${shards} shards`);
    } else {
      awards.push("practice seal");
    }
    if (progress.cleanSealChain > 0 && progress.cleanSealChain % 3 === 0) {
      progress.proofArmor += 1;
      awards.push("+1 Proof Armor");
    }
  } else {
    attempt.failedSeals += 1;
    if (progress.proofArmor > 0) {
      progress.proofArmor -= 1;
      awards.push("Proof Armor absorbed failure");
    } else {
      progress.cleanSealChain = 0;
      awards.push("Clean Seal Chain reset");
    }
  }

  updateLevel(progress);
  return awards;
}

async function recordRun(trialId) {
  const progress = await loadProgress();
  const attempt = progress.attempts[trialId] || { runs: 0, seals: 0, failedSeals: 0 };
  attempt.runs += 1;
  attempt.lastRunAt = new Date().toISOString();
  progress.attempts[trialId] = attempt;
  updateDailyPulse(progress);
  await saveProgress(progress);
  return progress;
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    textResponse(res, 403, "forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      textResponse(res, 404, "not found");
      return;
    }
    const ext = path.extname(filePath);
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes.get(ext) || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      textResponse(res, 404, "not found");
      return;
    }
    throw error;
  }
}

async function handleApi(req, res, pathname) {
  const trials = await loadTrials();

  if (req.method === "GET" && pathname === "/api/health") {
    jsonResponse(res, 200, { ok: true, sleyBin, host, port });
    return;
  }

  if (req.method === "GET" && pathname === "/api/trials") {
    jsonResponse(res, 200, { trials: trials.map(publicTrial) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/progress") {
    jsonResponse(res, 200, { progress: await loadProgress() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/run") {
    const body = await parseBody(req);
    const trial = findTrial(trials, body.trialId);
    validateSubmission(trial, body.code);
    const run = await runTrial(trial, body.code);
    const progress = await recordRun(trial.id);
    jsonResponse(res, 200, { ok: run.ok, run, progress });
    return;
  }

  if (req.method === "POST" && pathname === "/api/format") {
    const body = await parseBody(req);
    const trial = findTrial(trials, body.trialId);
    validateSubmission(trial, body.code);
    if (trial.mode !== "code") {
      jsonResponse(res, 400, { ok: false, error: "format is only available for code trials" });
      return;
    }
    const { sourcePath } = await writeRunFile(body.code);
    const formatted = await runSley(["format", sourcePath]);
    jsonResponse(res, 200, { ok: formatted.ok, formatted: formatted.stdout, stderr: formatted.stderr });
    return;
  }

  if (req.method === "POST" && pathname === "/api/graph") {
    const body = await parseBody(req);
    const trial = findTrial(trials, body.trialId);
    validateSubmission(trial, body.code);
    if (trial.mode !== "code") {
      jsonResponse(res, 400, { ok: false, error: "graph is only available for code trials" });
      return;
    }
    const { sourcePath } = await writeRunFile(body.code);
    const graph = await runSley(["graph", "--json", sourcePath]);
    jsonResponse(res, 200, { ok: graph.ok, graph: parseJsonOutput(graph), stdout: graph.stdout, stderr: graph.stderr });
    return;
  }

  if (req.method === "POST" && pathname === "/api/seal") {
    const body = await parseBody(req);
    const trial = findTrial(trials, body.trialId);
    validateSubmission(trial, body.code);
    const seal = await sealTrial(trial, body.code);
    const progress = await loadProgress();
    const awards = applySealProgress(progress, trial, seal.passed);
    await saveProgress(progress);
    jsonResponse(res, 200, { ok: seal.passed, seal, progress, awards });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: "unknown api route" });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error.statusCode || 500;
    jsonResponse(res, status, { ok: false, error: error.message || "internal error" });
  }
});

server.listen(port, host, () => {
  console.log(`LearnSley local server: http://${host}:${port}`);
  console.log(`Sley binary: ${sleyBin}`);
});
