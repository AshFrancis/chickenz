import { spawn } from "child_process";
import { writeFile, readFile, unlink, mkdir, rmdir } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
const PROVER_BINARY =
  process.env.PROVER_BINARY || resolve(import.meta.dir, "../../prover/target/release/chickenz-host");
const WORKER_TIMEOUT_MS = 60_000; // worker considered offline after 60s without poll

export interface ProofArtifacts {
  seal: string; // hex-encoded
  journal: string; // hex-encoded
  imageId: string; // hex-encoded
  boundlessRequestId?: string; // Boundless marketplace request ID (hex)
}

export interface ProofJob {
  matchId: string;
  transcript: object;
  status: "queued" | "claimed" | "done";
  claimedAt?: number;
  artifacts?: ProofArtifacts;
  onResult?: (artifacts: ProofArtifacts | null, source?: string) => void;
}

// ── Proof Queue ──────────────────────────────────────────

const proofQueue: ProofJob[] = [];
const MAX_QUEUE_SIZE = 50; // prevent unbounded memory growth
let lastWorkerPing = 0;
const JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function isWorkerOnline(): boolean {
  return Date.now() - lastWorkerPing < WORKER_TIMEOUT_MS;
}

export function workerHeartbeat() {
  lastWorkerPing = Date.now();
}

/** Queue a proof job. Called when a ranked match ends. Deduplicates by matchId. */
export function queueProof(
  matchId: string,
  transcript: object,
  onResult?: (artifacts: ProofArtifacts | null, source?: string) => void,
): ProofJob {
  // Prevent duplicate queue entries for the same match
  const existing = proofQueue.find((j) => j.matchId === matchId);
  if (existing) {
    console.log(`[prover] Job for ${matchId} already in queue (status: ${existing.status}), skipping`);
    return existing;
  }
  // Enforce max queue size — evict oldest done/queued jobs
  while (proofQueue.length >= MAX_QUEUE_SIZE) {
    const doneIdx = proofQueue.findIndex((j) => j.status === "done");
    if (doneIdx >= 0) {
      proofQueue.splice(doneIdx, 1);
    } else {
      // Drop oldest queued job
      const queuedIdx = proofQueue.findIndex((j) => j.status === "queued");
      if (queuedIdx >= 0) {
        console.log(`[prover] Queue full, dropping oldest job: ${proofQueue[queuedIdx]!.matchId}`);
        proofQueue.splice(queuedIdx, 1);
      } else {
        break; // All jobs are claimed — can't evict
      }
    }
  }
  const job: ProofJob = { matchId, transcript, status: "queued", onResult };
  proofQueue.push(job);
  console.log(`[prover] Queued proof for ${matchId} (queue size: ${proofQueue.length})`);
  return job;
}

/** Get the next unclaimed job for a worker. */
export function claimNextJob(): ProofJob | null {
  workerHeartbeat();
  pruneJobs();
  const job = proofQueue.find((j) => j.status === "queued");
  if (job) {
    job.status = "claimed";
    job.claimedAt = Date.now();
    console.log(`[prover] Job ${job.matchId} claimed by worker`);
  }
  return job ?? null;
}

/** Get a job's transcript for the worker to download (only if claimed). */
export function getJobTranscript(matchId: string): object | null {
  const job = proofQueue.find((j) => j.matchId === matchId && j.status === "claimed");
  return job?.transcript ?? null;
}

/** Worker submits proof result (only for claimed jobs). */
export function submitJobResult(matchId: string, artifacts: ProofArtifacts): ProofJob | null {
  const job = proofQueue.find((j) => j.matchId === matchId && j.status === "claimed");
  if (!job) return null;
  job.artifacts = artifacts;
  job.status = "done";
  console.log(`[prover] Proof received for ${matchId}`);
  // Invoke onResult callback if registered
  if (job.onResult) {
    try {
      job.onResult(artifacts, "worker");
    } catch (e) {
      console.error(`[prover] onResult callback error for ${matchId}:`, e);
    }
  }
  return job;
}

/** Prune completed jobs, reset stale claimed jobs. */
function pruneJobs() {
  const now = Date.now();
  for (let i = proofQueue.length - 1; i >= 0; i--) {
    const job = proofQueue[i]!;
    // Remove completed jobs (result already delivered via callback)
    if (job.status === "done") {
      proofQueue.splice(i, 1);
      continue;
    }
    // Reset claimed jobs stuck >5 min back to queued
    if (job.status === "claimed" && job.claimedAt && now - job.claimedAt > JOB_TIMEOUT_MS) {
      console.log(`[prover] Job ${job.matchId} timed out, re-queuing`);
      job.status = "queued";
      job.claimedAt = undefined;
    }
  }
}

/** Get a job by match ID. */
export function getJob(matchId: string): ProofJob | null {
  return proofQueue.find((j) => j.matchId === matchId) ?? null;
}

// ── Boundless fallback (spawns local binary) ─────────────

export async function proveBoundless(
  matchId: string,
  transcript: object,
  onRequestId?: (requestId: string) => void,
  onTxHash?: (txHash: string) => void,
): Promise<ProofArtifacts | null> {
  const workDir = join(tmpdir(), `chickenz-prove-${matchId}`);
  const inputPath = join(workDir, "input.json");
  const outputPath = join(workDir, "proof_artifacts.json");

  try {
    await mkdir(workDir, { recursive: true });
    await writeFile(inputPath, JSON.stringify(transcript));
    console.log(`[prover] Starting Boundless proof for ${matchId}...`);

    let stdout = "";
    let stderr = "";
    let capturedRequestId: string | undefined;
    let capturedTxHash: string | undefined;
    const result = await new Promise<number>((resolve, reject) => {
      const proc = spawn(PROVER_BINARY, ["--boundless", inputPath], {
        cwd: workDir,
        env: {
          ...process.env,
          RPC_URL: process.env.BOUNDLESS_RPC_URL,
          PRIVATE_KEY: process.env.BOUNDLESS_PRIVATE_KEY,
          PINATA_JWT: process.env.PINATA_JWT,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        // Capture Boundless request ID as soon as it's printed (before proof completes)
        if (!capturedRequestId) {
          const reqIdMatch = chunk.match(/Request ID:\s*([0-9a-fA-Fx]+)/);
          if (reqIdMatch) {
            capturedRequestId = reqIdMatch[1]!;
            console.log(`[prover] Boundless request ID for ${matchId}: ${capturedRequestId}`);
            onRequestId?.(capturedRequestId);
          }
        }
        // Capture tx hash from Boundless SDK tracing output: "Broadcasting tx <hash> with request ID"
        if (!capturedTxHash) {
          const txMatch = chunk.match(/Broadcasting tx (0x)?([0-9a-fA-F]{64})/);
          if (txMatch) {
            capturedTxHash = `0x${txMatch[2]!}`;
            console.log(`[prover] Boundless tx hash for ${matchId}: ${capturedTxHash}`);
            onTxHash?.(capturedTxHash);
          }
        }
      });
      proc.on("error", (err) => {
        console.error(`[prover] Failed to spawn Boundless for ${matchId}:`, err.message);
        reject(err);
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          console.error(`[prover] Boundless exited with code ${code} for ${matchId}`);
          if (stderr) console.error(`[prover] stderr: ${stderr.slice(0, 500)}`);
          if (stdout) console.log(`[prover] stdout: ${stdout.slice(0, 500)}`);
        }
        resolve(code ?? 1);
      });
    });

    if (result !== 0) return null;

    const artifactsRaw = await readFile(outputPath, "utf-8");
    const artifacts = JSON.parse(artifactsRaw) as ProofArtifacts;

    if (capturedRequestId) {
      artifacts.boundlessRequestId = capturedRequestId;
    }

    console.log(`[prover] Boundless proof generated for ${matchId}`);
    return artifacts;
  } catch (err) {
    console.error(`[prover] Error in Boundless proving ${matchId}:`, err);
    return null;
  } finally {
    try {
      await unlink(inputPath);
    } catch {
      /* cleanup */
    }
    try {
      await unlink(outputPath);
    } catch {
      /* cleanup */
    }
    try {
      await rmdir(workDir);
    } catch {
      /* cleanup */
    }
  }
}

/**
 * Race proof request: always queue for worker AND submit to Boundless.
 * Whichever finishes first wins. The onResult callback fires exactly once.
 */
export function proveMatch(
  matchId: string,
  transcript: object,
  onResult: (artifacts: ProofArtifacts | null, source?: string) => void,
  onBoundlessRequestId?: (requestId: string) => void,
  onBoundlessTxHash?: (txHash: string) => void,
) {
  let settled = false;

  function markJobDone() {
    const job = proofQueue.find((j) => j.matchId === matchId);
    if (job && job.status !== "done") {
      job.status = "done";
    }
  }

  const settleOnce = (source: string) => (artifacts: ProofArtifacts | null, _source?: string) => {
    if (settled) return;
    if (!artifacts) return;
    settled = true;
    markJobDone(); // Prevent workers from re-claiming
    console.log(`[prover] ${matchId} proved by ${source}`);
    onResult(artifacts, source);
  };

  // Safety timeout: if neither prover settles within 20 minutes, report failure
  // (Boundless marketplace queue can take 10-15 min on testnet)
  setTimeout(
    () => {
      if (!settled) {
        settled = true;
        markJobDone(); // Clean up stale job
        console.log(`[prover] ${matchId} timed out after 20 minutes`);
        onResult(null);
      }
    },
    20 * 60 * 1000,
  );

  // Always queue for worker (gaming PC polls these)
  queueProof(matchId, transcript, settleOnce("worker"));
  console.log(`[prover] Queued ${matchId} for worker`);

  // Also submit to Boundless in parallel
  if (process.env.BOUNDLESS_RPC_URL && process.env.BOUNDLESS_PRIVATE_KEY) {
    console.log(`[prover] Submitting ${matchId} to Boundless in parallel`);
    proveBoundless(matchId, transcript, onBoundlessRequestId, onBoundlessTxHash)
      .then((artifacts) => {
        if (artifacts) {
          settleOnce("boundless")(artifacts);
        } else {
          console.log(`[prover] Boundless failed for ${matchId}`);
          // If worker job is also gone (pruned/not claimed), give up
          if (!settled && !proofQueue.find((j) => j.matchId === matchId && j.status !== "done")) {
            settled = true;
            onResult(null);
          }
        }
      })
      .catch(() => {
        console.log(`[prover] Boundless error for ${matchId}`);
        if (!settled && !proofQueue.find((j) => j.matchId === matchId && j.status !== "done")) {
          settled = true;
          onResult(null);
        }
      });
  } else {
    console.log(`[prover] No Boundless config — ${matchId} relies on worker only`);
  }
}
